/*!
 * ws: a node.js websocket client
 * Copyright(c) 2011 Einar Otto Stangvik <einaros@gmail.com>
 * MIT Licensed
 */

var util = require('util')
  , events = require('events')
  , http = require('http')
  , crypto = require('crypto')
  , Options = require('options')
  , WebSocket = require('./WebSocket')
  , Extensions = require('./Extensions')
  , PerMessageDeflate = require('./PerMessageDeflate')
  , tls = require('tls')
  , url = require('url');

/**
 * WebSocket Server implementation
 */

function onServerConnection (req, res) {
  var body = http.STATUS_CODES[426];
  res.writeHead(426, {
    'Content-Length': body.length,
    'Content-Type': 'text/plain'
  });
  res.end(body);
}

function emitListening () {
  this.emit('listening');
}

function emitError (error) {
  this.emit('error', error);
}

function onUpgrade (requrl, client) {
  this.emit('connection'+requrl, client);
  this.emit('connection', client);
}

function doUpgrade (req, socket, upgradeHead) {
  //copy upgradeHead to avoid retention of large slab buffers used in node core
  var head = new Buffer(upgradeHead.length);
  upgradeHead.copy(head);

  this.handleUpgrade(req, socket, head, onUpgrade.bind(this, req.url));
}

function WebSocketServer(options, callback) {
  if (this instanceof WebSocketServer === false) {
    return new WebSocketServer(options, callback);
  }

  events.EventEmitter.call(this);

  options = new Options({
    host: '0.0.0.0',
    port: null,
    server: null,
    verifyClient: null,
    handleProtocols: null,
    path: null,
    noServer: false,
    disableHixie: false,
    clientTracking: true,
    perMessageDeflate: true,
    maxPayload: null
  }, '__destroy').merge(options);

  if (!options.isDefinedAndNonNull('port') && !options.isDefinedAndNonNull('server') && !options.value.noServer) {
    options.destroy();
    throw new TypeError('`port` or a `server` must be provided');
  }

  if (options.isDefinedAndNonNull('port')) {
    this._server = http.createServer(onServerConnection);
    this._server.allowHalfOpen = false;
    this._server.listen(options.value.port, options.value.host, callback);
  }
  else if (options.value.server) {
    this._server = options.value.server;
    if (options.value.path) {
      // take note of the path, to avoid collisions when multiple websocket servers are
      // listening on the same http server
      if (this._server._webSocketPaths && options.value.server._webSocketPaths[options.value.path]) {
        throw new Error('two instances of WebSocketServer cannot listen on the same http server path');
      }
      if (typeof this._server._webSocketPaths !== 'object') {
        this._server._webSocketPaths = {};
      }
      this._server._webSocketPaths[options.value.path] = 1;
    }
  }
  if (this._server) {
    this._onceServerListening = emitListening.bind(this);
    this._server.once('listening', this._onceServerListening);
  }

  if (typeof this._server != 'undefined') {
    this._onServerError = emitError.bind(this);
    this._server.on('error', this._onServerError);
    this._onServerUpgrade = doUpgrade.bind(this);
    this._server.on('upgrade', this._onServerUpgrade);
  }

  this.options = options.value;
  this.path = options.value.path;
  this.clients = [];
}

/**
 * Inherits from EventEmitter.
 */

util.inherits(WebSocketServer, events.EventEmitter);

/**
 * Immediately shuts down the connection.
 *
 * @api public
 */

WebSocketServer.prototype.close = function(callback) {
  // terminate all associated clients
  var error = null;
  try {
    for (var i = 0, l = this.clients.length; i < l; ++i) {
      this.clients[i].terminate();
    }
  }
  catch (e) {
    error = e;
  }

  // remove path descriptor, if any
  if (this.path && this._server._webSocketPaths) {
    delete this._server._webSocketPaths[this.path];
    if (Object.keys(this._server._webSocketPaths).length == 0) {
      delete this._server._webSocketPaths;
    }
  }

  // close the http server if it was internally created
  try {
    if (this._server)
      this._server.close()
  }
  finally {
    if (this._server) {
      this._server.removeListener('listening', this._onceServerListening);
      this._onceServerListening = null;
      this._server.removeListener('error', this._onServerError);
      this._server.removeListener('upgrade', this._onServerUpgrade);
    }
    if (this.options) {
      this.options.__destroy();
      this.options = null;
    }
    delete this._server;
  }
  if(callback)
    callback(error);
  else if(error)
    throw error;
}

/**
 * Handle a HTTP Upgrade request.
 *
 * @api public
 */

WebSocketServer.prototype.handleUpgrade = function(req, socket, upgradeHead, cb) {
  // check for wrong path
  if (this.options.path) {
    var u = url.parse(req.url);
    if (u && u.pathname !== this.options.path) return;
  }

  if (typeof req.headers.upgrade === 'undefined' || req.headers.upgrade.toLowerCase() !== 'websocket') {
    abortConnection(socket, 400, 'Bad Request');
    return;
  }

  if (req.headers['sec-websocket-key1']) handleHixieUpgrade.apply(this, arguments);
  else handleHybiUpgrade.apply(this, arguments);
}

WebSocketServer.prototype.onClientDown = function (client) {
  var index = this.clients.indexOf(client);
  if (index != -1) {
    this.clients.splice(index, 1);
  }
};

module.exports = WebSocketServer;

/**
 * Entirely private apis,
 * which may or may not be bound to a sepcific WebSocket instance.
 */

function handleHybiUpgrade(req, socket, upgradeHead, cb) {
  // handle premature socket errors
  new HybiUpgrader(this, req, socket, upgradeHead, cb);
}

function HybiUpgrader (websocketserver, req, socket, upgradeHead, cb) {
  // verify key presence
  if (!req.headers['sec-websocket-key']) {
    abortConnection(socket, 400, 'Bad Request');
    return;
  }

  // verify version
  var version = parseInt(req.headers['sec-websocket-version']);
  if ([8, 13].indexOf(version) === -1) {
    abortConnection(socket, 400, 'Bad Request');
    return;
  }

  this.server = websocketserver;
  this.req = req;
  this.socket = socket;
  this.upgradeHead = upgradeHead;
  this.cb = cb;
  this.errorer = this.onError.bind(this);

  socket.on('error', this.errorer);

  // verify protocol

  // verify client
  var origin = version < 13 ?
    req.headers['sec-websocket-origin'] :
    req.headers['origin'];

  // handler to call when the connection sequence completes
  // optionally call external client verification handler
  if (typeof websocketserver.options.verifyClient == 'function') {
    var info = {
      origin: origin,
      secure: typeof req.connection.authorized !== 'undefined' || typeof req.connection.encrypted !== 'undefined',
      req: req
    };
    if (websocketserver.options.verifyClient.length == 2) {
      websocketserver.options.verifyClient(info, this.onVerifyClient.bind(this));
      return;
    }
    else if (!websocketserver.options.verifyClient(info)) {
      abortConnection(socket, 401, 'Unauthorized');
      return;
    }
  }

  this.completeHybiUpgrade1();
}
HybiUpgrader.prototype.destroy = function () {
  this.errorer = null;
  this.cb = null;
  this.upgradeHead = null;
  this.socket = null;
  this.req = null;
  this.server = null;
};
HybiUpgrader.prototype.onError = function (err) {
  if (this.socket) {
    this.socket.destroy();
    this.destroy();
  }
};
HybiUpgrader.prototype.onVerifyClient = function(result, code, name) {
  if (typeof code === 'undefined') code = 401;
  if (typeof name === 'undefined') name = http.STATUS_CODES[code];

  if (!result) abortConnection(this.socket, code, name);
  else this.completeHybiUpgrade1();
};
HybiUpgrader.prototype.completeHybiUpgrade1 = function() {
  // choose from the sub-protocols
  var protocols = this.req.headers['sec-websocket-protocol'];
  if (typeof this.server.options.handleProtocols == 'function') {
    var protList = (protocols || "").split(/, */);
    var phobj = {
      callbackCalled: false
    };
    var res = this.server.options.handleProtocols(protList, this.protocolHandler.bind(this, phobj));
    if (!phobj.callbackCalled) {
      // the handleProtocols handler never called our callback
      abortConnection(this.socket, 501, 'Could not process protocols');
    }
    return;
  } else {
    if (typeof protocols !== 'undefined') {
      this.completeHybiUpgrade2(protocols.split(/, */)[0]);
    }
    else {
      this.completeHybiUpgrade2();
    }
  }
};
HybiUpgrader.prototype.protocolHandler = function (phobj, result, protocol) {
    phobj.callbackCalled = true;
    if (!result) abortConnection(this.socket, 401, 'Unauthorized');
    else this.completeHybiUpgrade2(protocol);
};
HybiUpgrader.prototype.completeHybiUpgrade2 = function(protocol) {

  // calc key
  var key = this.req.headers['sec-websocket-key'];
  // handle extensions offer
  var extensionsOffer = Extensions.parse(this.req.headers['sec-websocket-extensions']);
  var version = parseInt(this.req.headers['sec-websocket-version']);

  var shasum = crypto.createHash('sha1');
  shasum.update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11");
  key = shasum.digest('base64');

  var headers = [
      'HTTP/1.1 101 Switching Protocols'
    , 'Upgrade: websocket'
    , 'Connection: Upgrade'
    , 'Sec-WebSocket-Accept: ' + key
  ];

  if (typeof protocol != 'undefined') {
    headers.push('Sec-WebSocket-Protocol: ' + protocol);
  }

  var extensions = {};
  try {
    extensions = acceptExtensions.call(this.server, extensionsOffer);
  } catch (err) {
    console.error(err.stack);
    console.error(err);
    abortConnection(this.socket, 400, 'Bad Request');
    this.destroy();
    return;
  }

  if (Object.keys(extensions).length) {
    //var serverExtensions = {};
    var serverExtensions = Object.keys(extensions).reduce(function(ret, token) {
      ret[token] = [extensions[token].params];
      return ret;
    }, {});
    headers.push('Sec-WebSocket-Extensions: ' + Extensions.format(serverExtensions));
  }

  // allows external modification/inspection of handshake headers
  this.server.emit('headers', headers);

  this.socket.setTimeout(0);
  this.socket.setNoDelay(true);
  try {
    this.socket.write(headers.concat('', '').join('\r\n'));
  }
  catch (e) {
    // if the upgrade write fails, shut the connection down hard
    try { socket.destroy(); } catch (e) {}
    return;
  }
  var client = new WebSocket([this.req, this.socket, this.upgradeHead], {
    protocolVersion: version,
    protocol: protocol,
    extensions: extensions,
    maxPayload: this.server.options.maxPayload
  });

  if (this.server.options.clientTracking) {
    this.server.clients.push(client);
    client.on('close', this.server.onClientDown.bind(this.server, client));
  }

  // signal upgrade complete
  this.socket.removeListener('error', this.errorer);
  this.cb(client);
  this.destroy();
};

function handleHixieUpgrade(req, socket, upgradeHead, cb) {
  // handle premature socket errors
  var errorHandler = function() {
    try { socket.destroy(); } catch (e) {}
  }
  socket.on('error', errorHandler);

  // bail if options prevent hixie
  if (this.options.disableHixie) {
    abortConnection(socket, 401, 'Hixie support disabled');
    return;
  }

  // verify key presence
  if (!req.headers['sec-websocket-key2']) {
    abortConnection(socket, 400, 'Bad Request');
    return;
  }

  var origin = req.headers['origin']
    , self = this;

  // setup handshake completion to run after client has been verified
  var onClientVerified = function() {
    var wshost;
    if (!req.headers['x-forwarded-host'])
        wshost = req.headers.host;
    else
        wshost = req.headers['x-forwarded-host'];
    var location = ((req.headers['x-forwarded-proto'] === 'https' || socket.encrypted) ? 'wss' : 'ws') + '://' + wshost + req.url
      , protocol = req.headers['sec-websocket-protocol'];

    // build the response header and return a Buffer
    var buildResponseHeader = function() {
      var headers = [
          'HTTP/1.1 101 Switching Protocols'
        , 'Upgrade: WebSocket'
        , 'Connection: Upgrade'
        , 'Sec-WebSocket-Location: ' + location
      ];
      if (typeof protocol != 'undefined') headers.push('Sec-WebSocket-Protocol: ' + protocol);
      if (typeof origin != 'undefined') headers.push('Sec-WebSocket-Origin: ' + origin);

      return new Buffer(headers.concat('', '').join('\r\n'));
    };

    // send handshake response before receiving the nonce
    var handshakeResponse = function() {

      socket.setTimeout(0);
      socket.setNoDelay(true);

      var headerBuffer = buildResponseHeader();

      try {
        socket.write(headerBuffer, 'binary', function(err) {
          // remove listener if there was an error
          if (err) socket.removeListener('data', handler);
          return;
        });
      } catch (e) {
        try { socket.destroy(); } catch (e) {}
        return;
      };
    };

    // handshake completion code to run once nonce has been successfully retrieved
    var completeHandshake = function(nonce, rest, headerBuffer) {
      // calculate key
      var k1 = req.headers['sec-websocket-key1']
        , k2 = req.headers['sec-websocket-key2']
        , md5 = crypto.createHash('md5');

      [k1, k2].forEach(function (k) {
        var n = parseInt(k.replace(/[^\d]/g, ''))
          , spaces = k.replace(/[^ ]/g, '').length;
        if (spaces === 0 || n % spaces !== 0){
          abortConnection(socket, 400, 'Bad Request');
          return;
        }
        n /= spaces;
        md5.update(String.fromCharCode(
          n >> 24 & 0xFF,
          n >> 16 & 0xFF,
          n >> 8  & 0xFF,
          n       & 0xFF));
      });
      md5.update(nonce.toString('binary'));

      socket.setTimeout(0);
      socket.setNoDelay(true);

      try {
        var hashBuffer = new Buffer(md5.digest('binary'), 'binary');
        var handshakeBuffer = new Buffer(headerBuffer.length + hashBuffer.length);
        headerBuffer.copy(handshakeBuffer, 0);
        hashBuffer.copy(handshakeBuffer, headerBuffer.length);

        // do a single write, which - upon success - causes a new client websocket to be setup
        socket.write(handshakeBuffer, 'binary', function(err) {
          if (err) return; // do not create client if an error happens
          var client = new WebSocket([req, socket, rest], {
            protocolVersion: 'hixie-76',
            protocol: protocol
          });
          if (self.options.clientTracking) {
            self.clients.push(client);
            client.on('close', function() {
              var index = self.clients.indexOf(client);
              if (index != -1) {
                self.clients.splice(index, 1);
              }
            });
          }

          // signal upgrade complete
          socket.removeListener('error', errorHandler);
          cb(client);
        });
      }
      catch (e) {
        try { socket.destroy(); } catch (e) {}
        return;
      }
    }

    // retrieve nonce
    var nonceLength = 8;
    if (upgradeHead && upgradeHead.length >= nonceLength) {
      var nonce = upgradeHead.slice(0, nonceLength);
      var rest = upgradeHead.length > nonceLength ? upgradeHead.slice(nonceLength) : null;
      completeHandshake.call(self, nonce, rest, buildResponseHeader());
    }
    else {
      // nonce not present in upgradeHead
      var nonce = new Buffer(nonceLength);
      upgradeHead.copy(nonce, 0);
      var received = upgradeHead.length;
      var rest = null;
      var handler = function (data) {
        var toRead = Math.min(data.length, nonceLength - received);
        if (toRead === 0) return;
        data.copy(nonce, received, 0, toRead);
        received += toRead;
        if (received == nonceLength) {
          socket.removeListener('data', handler);
          if (toRead < data.length) rest = data.slice(toRead);

          // complete the handshake but send empty buffer for headers since they have already been sent
          completeHandshake.call(self, nonce, rest, new Buffer(0));
        }
      }

      // handle additional data as we receive it
      socket.on('data', handler);

      // send header response before we have the nonce to fix haproxy buffering
      handshakeResponse();
    }
  }

  // verify client
  if (typeof this.options.verifyClient == 'function') {
    var info = {
      origin: origin,
      secure: typeof req.connection.authorized !== 'undefined' || typeof req.connection.encrypted !== 'undefined',
      req: req
    };
    if (this.options.verifyClient.length == 2) {
      var self = this;
      this.options.verifyClient(info, function(result, code, name) {
        if (typeof code === 'undefined') code = 401;
        if (typeof name === 'undefined') name = http.STATUS_CODES[code];

        if (!result) abortConnection(socket, code, name);
        else onClientVerified.apply(self);
      });
      return;
    }
    else if (!this.options.verifyClient(info)) {
      abortConnection(socket, 401, 'Unauthorized');
      return;
    }
  }

  // no client verification required
  onClientVerified();
}

function acceptExtensions(offer) {
  var extensions = {};
  var options = this.options.perMessageDeflate;
  var maxPayload = this.options.maxPayload;
  if (options && offer[PerMessageDeflate.extensionName]) {
    var perMessageDeflate = new PerMessageDeflate(options !== true ? options : {}, true, maxPayload);
    perMessageDeflate.accept(offer[PerMessageDeflate.extensionName]);
    extensions[PerMessageDeflate.extensionName] = perMessageDeflate;
  }
  return extensions;
}

function abortConnection(socket, code, name) {
  try {
    var response = [
      'HTTP/1.1 ' + code + ' ' + name,
      'Content-type: text/html'
    ];
    socket.write(response.concat('', '').join('\r\n'));
  }
  catch (e) { /* ignore errors - we've aborted this connection */ }
  finally {
    // ensure that an early aborted connection is shut down completely
    try { socket.destroy(); } catch (e) {}
  }
}
