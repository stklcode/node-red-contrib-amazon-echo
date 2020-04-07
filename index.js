module.exports = function(RED) {
  'use strict';

  const HueColor = require('hue-colors').default;
  const path = require('path');
  const State = require(path.join(__dirname, '/api/hue/model/lights/State.js'));
  const Info = require(path.join(__dirname, '/api/hue/model/lights/Info.js'));
  const SetResponse = require(path.join(__dirname, '/api/hue/model/lights/SetResponse.js'));
  const Capabilities = require(path.join(__dirname, '/api/hue/model/lights/Capabilities.js'));
  const GlobalState = require(path.join(__dirname, '/api/hue/model/State.js'));
  const Registration = require(path.join(__dirname, '/api/hue/model/Registration.js'));

  function AmazonEchoDeviceNode(config) {
    RED.nodes.createNode(this, config);
    var deviceNode = this;

    deviceNode.on('input', function(msg) {

      var nodeDeviceId = formatUUID(config.id);

      if (nodeDeviceId == msg.deviceid) {
        msg.topic = config.topic;
        deviceNode.send(msg);
      }

    });
  }

  // NodeRED registration
  RED.nodes.registerType('amazon-echo-device', AmazonEchoDeviceNode, {});

  function AmazonEchoHubNode(config) {

    RED.nodes.createNode(this, config);
    var hubNode = this;

    var port = config.port > 0 && config.port < 65536 ? config.port : 80;

    // Start SSDP service
    var ssdpServer = ssdp(port, config);
    if (config.discovery) {
      ssdpServer.start();
    }

    // Stoppable kill the server on deploy
    const graceMilliseconds = 500;
    var stoppable = require('stoppable');
    var http = require('http');
    var app = require('express')();
    var httpServer = stoppable(http.createServer(app), graceMilliseconds);

    httpServer.on('error', function(error) {
      hubNode.status({
        fill: 'red',
        shape: 'ring',
        text: 'Unable to start on port ' + port
      });
      RED.log.error(error);
      return;
    });

    httpServer.listen(port, function(error) {

      if (error) {
        hubNode.status({
          fill: 'red',
          shape: 'ring',
          text: 'Unable to start on port ' + port
        });
        RED.log.error(error);
        return;
      }

      hubNode.status({
        fill: 'green',
        shape: 'dot',
        text: 'online'
      });

      // REST API Settings
      api(app, hubNode, config);
    });

    hubNode.on('input', function(msg) {

      var nodeDeviceId = null;

      if (typeof msg.payload === 'object') {

        if ('nodeid' in msg.payload && msg.payload.nodeid !== null) {

          nodeDeviceId = msg.payload.nodeid
          delete msg.payload['nodeid'];

        } else {

          if ('nodename' in msg.payload && msg.payload.nodename !== null) {
            getDevices().forEach(function(device) {
              if (msg.payload.nodename == device.name) {
                nodeDeviceId = device.id
                delete msg.payload['nodename'];
              }
            });
          }

        }
      }

      if (config.processinput > 0 && nodeDeviceId !== null) {

        var deviceid = formatUUID(nodeDeviceId);

        var meta = {
          insert: {
            by: 'input',
            details: {}
          }
        }

        var deviceAttributes = setDeviceAttributes(deviceid, msg.payload, meta, hubNode.context());

        // Output if
        // 'Process and output' OR
        // 'Process and output on state change' option is selected
        if (config.processinput == 2 || (config.processinput == 3 && Object.keys(deviceAttributes.meta.changes).length > 0)) {
          payloadHandler(hubNode, deviceid);
        }

      }
    });

    hubNode.on('close', function(removed, doneFunction) {
      // Stop SSDP server
      ssdpServer.stop();

      // Stop HTTP server
      httpServer.stop(function() {
        if (typeof doneFunction === 'function')
          doneFunction();
        RED.log.info('Alexa Local Hub closing done...');
      });
      setImmediate(function() {
        httpServer.emit('close');
      });
    });
  }

  // NodeRED registration
  RED.nodes.registerType('amazon-echo-hub', AmazonEchoHubNode, {});

  //
  // REST API
  //
  function api(app, hubNode, config) {

    const Mustache = require('mustache');

    var fs = require('fs');
    var bodyParser = require('body-parser');

    app.use(bodyParser.json({
      type: '*/*'
    }));

    app.use(function(err, req, res, next) {
      if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
        RED.log.debug('Error: Invalid JSON request: ' + JSON.stringify(err.body));
      }
      next();
    });

    app.use(function(req, res, next) {
      if (Object.keys(req.body).length > 0)
        RED.log.debug('Request body: ' + JSON.stringify(req.body));
      next();
    });

    app.get('/description.xml', function(req, res) {
      var template = fs.readFileSync(__dirname + '/api/hue/templates/description.xml').toString();

      var data = {
        address: req.hostname,
        port: req.connection.localPort,
        huehubid: getHueHubId(config)
      };

      var output = Mustache.render(template, data);

      res.type('application/xml');
      res.send(output);
    });

    app.post('/api', function(req, res) {
      const output = new Registration();
      output.success('c6260f982b43a226b5542b967f612ce');
      res.json(output);
    });

    app.get('/api/:username', function(req, res) {
      const lights = [];
      const sensors = [];

      getDevicesAttributes(hubNode.context()).forEach(d => {
        const uid = hueUniqueId(d.id);
        switch (d.devtype) {
          case 'light':
            const state = new State(d.on, d.bri, d.hue, d.sat, d.ct, d.colormode);
            switch (d.model) {
              case 'ext': // Extended Color Light.
                lights[d.id] = Info.forRGBW(d.name, state).extended(uid).withCapabilities(Capabilities.forRGBW());
                break;
              case 'ct': // Color Temperature Light.
                lights[d.id] = Info.forCT(d.name, state).extended(uid).withCapabilities(Capabilities.forCT());
                break;
              case 'dim': // Dimmable light.
                lights[d.id] = Info.forDimmable(d.name, state).extended(uid).withCapabilities(Capabilities.forDimmable());
                break;
              case 'onoff': // On/off light.
                lights[d.id] = Info.forOnOff(d.name, state).extended(uid).withCapabilities(Capabilities.forDimmable());
                break;
              default:
                // TODO: error for unsupported model
            }
            break;
          case 'sensor':
            switch (d.model) {
              // TODO: add sensor models.
              default:
                // TODO: error for unsupported model
            }
            break;
          default:
          // TODO: error for unsupported device type
        }
        return l;
      }, {});

      const output = new GlobalState(req.hostname, req.params.username)
        .withLights(lights)
        .withSensors(sensors);

      res.json(output);
    });

    app.get('/api/:username/lights', function(req, res) {
      const output = getDevicesAttributes(hubNode.context())
        .filter(d => 'light' === d.devtype)
        .reduce((lights, d) => {
          const uid = hueUniqueId(d.id);
          const state = new State(d.on, d.bri, d.hue, d.sat, d.ct, d.colormode);
          switch (d.model) {
            case 'ext': // Extended Color Light.
              lights[d.id] = Info.forRGBW(d.name, state).extended(uid).withCapabilities(Capabilities.forRGBW());
              break;
            case 'ct': // Color Temperature Light.
              lights[d.id] = Info.forCT(d.name, state).extended(uid).withCapabilities(Capabilities.forCT());
              break;
            case 'dim': // Dimmable light.
              lights[d.id] = Info.forDimmable(d.name, state).extended(uid).withCapabilities(Capabilities.forDimmable());
              break;
            default: // Extended Color Light (default).
              // TODO: error for unsupported model
          }
          return lights;
        }, {});

      res.json(output);
    });

    app.get('/api/:username/lights/:id', function (req, res) {
      var device = getDevice(req.params.id);

      var data = getDeviceAttributes(req.params.id, hubNode.context());
      var state = new State(data.on, data.bri, data.hue, data.sat, data.ct, data.colormode);

      var info;
      if ('light' === device.devtype) {
        switch (device.model) {
          case 'ext': // Extended Color Light.
            info = Info.forRGBW(device.name, state);
            break;
          case 'ct': // Color Temperature Light.
            info = Info.forCT(device.name, state);
            break;
          case 'dim': // Dimmable light.
            info = Info.forDimmable(device.name, state);
            break;
          case 'onoff': // On/off light.
            info = Info.forOnOff(device.name, state);
            break;
          default:
            // TODO: error for unsupported model
        }
      } else {
        // TODO: error for unsupported device type
      }

      res.json(info);
    });

    app.put('/api/:username/lights/:id/state', function (req, res) {

      const meta = {
        insert: {
          by: 'alexa',
          details: {
            ip: req.headers['x-forwarded-for'] ||
              req.connection.remoteAddress ||
              '',
            user_agent: req.headers['user-agent']
          }
        }
      };

      setDeviceAttributes(req.params.id, req.body, meta, hubNode.context());
      const data = getDeviceAttributes(req.params.id, hubNode.context());

      var device = getDevice(req.params.id);

      let output;

      if (device.devtype === 'light') {
        output = new SetResponse();
        output.success('on', data.on);

        switch (device.model) {
          case 'ext': // Extended Color Light.
            output.success('bri', data.bri);
            output.success('ct', data.ct);
            output.success('hue', data.hue);
            output.success('sat', data.sat);
            break;
          case 'ct':   // Color Temperature Light.
            output.success('ct', data.ct);
            output.success('bri', data.bri);
            if (req.body.hasOwnProperty('hue')) {
              output.error('hue', data.hue);
            }
            if (req.body.hasOwnProperty('sat')) {
              output.error('sat', data.sat);
            }
            break;
          case 'dim': // Dimmable light.
            output.success('bri', data.bri);
            if (req.body.hasOwnProperty('ct')) {
              output.error('ct', data.ct);
            }
            if (req.body.hasOwnProperty('hue')) {
              output.error('hue', data.hue);
            }
            if (req.body.hasOwnProperty('sat')) {
              output.error('sat', data.sat);
            }
            break;
          case 'onoff': // On/Off light.
            if (req.body.hasOwnProperty('bri')) {
              output.error('bri', data.bri);
            }
            if (req.body.hasOwnProperty('ct')) {
              output.error('ct', data.ct);
            }
            if (req.body.hasOwnProperty('hue')) {
              output.error('hue', data.hue);
            }
            if (req.body.hasOwnProperty('sat')) {
              output.error('sat', data.sat);
            }
            break;
          default:
            // TODO: error for unsupported model
        }
      } else {
        // TODO: error for unsupported device type
      }

      res.json(output);

      payloadHandler(hubNode, req.params.id);
    });

  }

  //
  // SSDP
  //
  function ssdp(port, config) {

    var ssdpService = require('node-ssdp').Server,
      server = new ssdpService({
        location: {
          port: port,
          path: '/description.xml'
        },
        udn: 'uuid:' + getHueHubId(config)
      });

    server.addUSN('upnp:rootdevice');
    server.addUSN('urn:schemas-upnp-org:device:basic:1');

    return server;
  }

  //
  // Helpers
  //
  function getOrDefault(key, defaultValue, context) {

    var value = null;
    var storageValue = context.get(key);

    // Clone value
    if (storageValue !== undefined) {
      value = Object.assign({}, storageValue);
    }

    return valueOrDefault(value, defaultValue);
  }

  function valueOrDefault(value, defaultValue) {

    if (value === undefined || value === null) {
      value = defaultValue;
    }

    return value;
  }

  function formatUUID(id) {

    if (id === null || id === undefined)
      return '';
    return ('' + id).replace('.', '').trim();
  }

  function hueUniqueId(id) {
    return (id + '0000').replace(/(.{2})/g, "$1:").substring(0, 23) + '-00';
  }

  function getHueHubId(config) {

    var uuid = '00112233-4455-6677-8899-';
    uuid += formatUUID(config.id);
    return uuid;
  }

  function getDevices() {

    var devices = [];

    RED.nodes.eachNode(function (node) {
      if (node.type == 'amazon-echo-device') {
        devices.push({
          id: formatUUID(node.id),
          name: node.name,
          type: node.type,
          devtype: node.devtype,
          model: node.devmodel
        });
      }
    });

    return devices;
  }

  function getDevice(id) {
    for (let d of getDevices()) {
      if (id === d.id) {
        return d;
      }
    }
    return null;
  }

  function getDeviceAttributes(id, context) {

    var defaultAttributes = {
      on: false,
      bri: 254,
      percentage: 100,
      hue: 0,
      sat: 254,
      xy: [0.6484272236872118, 0.33085610147277794],
      ct: 199,
      rgb: [254, 0, 0],
      colormode: 'ct',
      meta: {}
    };

    return getOrDefault(id, defaultAttributes, context);
  }

  function getDevicesAttributes(context) {

    var devices = getDevices();
    var devicesAttributes = [];

    for (var key in devices) {
      var attributes = getDeviceAttributes(devices[key].id, context);
      devicesAttributes.push(Object.assign({}, attributes, devices[key]));
    }

    return devicesAttributes;
  }

  function setDeviceAttributes(id, attributes, meta, context) {

    // Reset meta attribute
    meta['insert']['details']['date'] = new Date();
    meta['input'] = attributes;
    meta['changes'] = {};

    var saved = getDeviceAttributes(id, context);
    var current = {};

    // Set defaults
    for (var key in saved) {
      current[key] = valueOrDefault(attributes[key], saved[key]);
    }

    // Set color temperature
    if (attributes.ct !== undefined) {
      current.colormode = 'ct';
    }

    // Set Hue color
    if (attributes.hue !== undefined && attributes.sat !== undefined) {
      var hueColor = HueColor.fromHsb(current.hue, current.sat, current.bri);
      var cie = hueColor.toCie();
      var rgb = hueColor.toRgb();
      current.xy = [cie[0] || 0, cie[1] || 0];
      current.rgb = rgb;
      current.colormode = 'hs';
    }

    // Set CIE
    if (attributes.xy !== undefined && Array.isArray(attributes.xy) && attributes.xy.length == 2) {
      var hueColor = HueColor.fromCIE(current.xy[0], current.xy[1], current.bri);
      var hsb = hueColor.toHsb();
      var rgb = hueColor.toRgb();
      current.hue = hsb[0] || 0;
      current.sat = hsb[1] || 0;
      current.rgb = rgb;
      current.colormode = 'hs';
    }

    // Set RGB
    if (attributes.rgb !== undefined && Array.isArray(attributes.rgb) && attributes.rgb.length == 3) {
      var hueColor = HueColor.fromRgb(current.rgb[0], current.rgb[1], current.rgb[2]);
      var hsb = hueColor.toHsb();
      var cie = hueColor.toCie();
      current.hue = hsb[0] || 0;
      current.sat = hsb[1] || 0;
      current.bri = hsb[2] || 0;
      current.xy = [cie[0] || 0, cie[1] || 0]
      current.colormode = 'hs';
    }

    // Set brightness percentage
    current.percentage = Math.floor(current.bri / 253 * 100);

    // Populate meta.changes
    for (var key in saved) {
      if (JSON.stringify(saved[key]) !== JSON.stringify(current[key])) {
        meta['changes'][key] = saved[key];
      }
    }

    // Include meta
    current['meta'] = meta;

    // Save attributes
    context.set(id, current);

    // Set payload
    current.payload = current.on ? 'on' : 'off';

    return getOrDefault(id, current, context);
  }

  //
  // Handlers
  //
  function payloadHandler(hubNode, deviceId) {

    var msg = getDeviceAttributes(deviceId, hubNode.context());
    msg.deviceid = deviceId;
    msg.topic = '';

    hubNode.send(msg);
  }

}
