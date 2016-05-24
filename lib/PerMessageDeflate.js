
var zlib = require('zlib');

var AVAILABLE_WINDOW_BITS = [8, 9, 10, 11, 12, 13, 14, 15];
var DEFAULT_WINDOW_BITS = 15;
var DEFAULT_MEM_LEVEL = 8;

PerMessageDeflate.extensionName = 'permessage-deflate';

function CompressJob (permessagedeflate) {
  var endpoint = permessagedeflate._isServer ? 'server' : 'client';
  var maxWindowBits = permessagedeflate.params[endpoint + '_max_window_bits'];
  this.permessagedeflate = permessagedeflate;
  this.endpoint = endpoint;
  this.fin = null;
  this.cb = null;
  this.buffers = [];
  this.handler = this.onData.bind(this);
  this.errorer = this.onError.bind(this);
  this.deflate = zlib.createDeflateRaw({
    flush: zlib.Z_SYNC_FLUSH,
    windowBits: 'number' === typeof maxWindowBits ? maxWindowBits : DEFAULT_WINDOW_BITS,
    memLevel: permessagedeflate._options.memLevel || DEFAULT_MEM_LEVEL
  });

  this.deflate.on('error', this.errorer).on('data', this.handler);
}
CompressJob.prototype.destroy = function () {
  this.buffers = [];
  if (!this.permessagedeflate) {
    return;
  }
  if (!((this.fin && this.permessagedeflate.params[this.endpoint + '_no_context_takeover']) || this.deflate.pendingClose)) {
    return;
  }
  if (this.deflate) {
    this.deflate.removeListener('error', this.errorer);
    this.deflate.removeListener('data', this.handler);
    this.deflate.close();
  }
  this.deflate = null;
  this.errorer = null;
  this.handler = null;
  this.buffers = null;
  this.cb = null;
  this.fin = null;
  this.endpoint = null;
  this.permessagedeflate._deflate = null;
  this.permessagedeflate = null;
};
CompressJob.prototype.write = function (data, fin, callback) {
  this.fin = fin;
  this.cb = callback;
  this.deflate.write(data);
  this.deflate.flush(this.onDone.bind(this));
};
CompressJob.prototype.onDone = function() {
  var data = Buffer.concat(this.buffers);
  if (this.fin) {
    data = data.slice(0, data.length - 4);
  }
  this.cb(null, data);
  this.destroy();
};
CompressJob.prototype.onError = function (err) {
  this.cb(err);
  this.destroy();
};
CompressJob.prototype.onData = function (buffer) {
  this.buffers.push(buffer);
};

function DecompressJob(permessagedeflate) {
  var endpoint = permessagedeflate._isServer ? 'client' : 'server';
  var maxWindowBits = permessagedeflate.params[endpoint + '_max_window_bits'];
  this.permessagedeflate = permessagedeflate;
  this.endpoint = endpoint;
  this.maxPayload = 
    ( permessagedeflate._maxPayload!==undefined &&
      permessagedeflate._maxPayload!==null &&
      permessagedeflate._maxPayload>0 ) ? permessagedeflate._maxPayload : 0;
  this.cumulativeBufferLength = 0;
  this.fin = null;
  this.cb = null;
  this.buffers = [];
  this.handler = this.onData.bind(this);
  this.errorer = this.onError.bind(this);
  this.inflate = zlib.createInflateRaw({
    windowBits: 'number' === typeof maxWindowBits ? maxWindowBits : DEFAULT_WINDOW_BITS
  });
  this.inflate.on('error', this.errorer).on('data', this.handler);
}
DecompressJob.prototype.destroy = function () {
  this.buffers = [];
  if (!this.permessagedeflate) {
    return;
  }
  if (!((this.fin && this.permessagedeflate.params[this.endpoint + '_no_context_takeover']) || this.inflate.pendingClose)) {
    return;
  }
  if (this.inflate) {
    this.inflate.removeListener('data', this.handler);
    this.inflate.removeListener('error', this.errorer);
    this.inflate.close();
  }
  this.inflate = null;
  this.errorer = null;
  this.handler = null;
  this.buffers = null;
  this.cb = null;
  this.fin = null;
  this.cumulativeBufferLength = null;
  this.maxPayload = null;
  this.endpoint = null;
  this.permessagedeflate._inflate = null;
  this.permessagedeflate = null;
};
DecompressJob.prototype.onDone = function () {
  this.cb(null, Buffer.concat(this.buffers));
  this.destroy();
};
DecompressJob.prototype.write = function (data, fin, callback) {
  this.fin = fin;
  this.cb = callback;
  this.inflate.write(data);
  if (this.fin) {
    this.inflate.write(new Buffer([0x00, 0x00, 0xff, 0xff]));
  }
  this.inflate.flush(this.onDone.bind(this));
};
DecompressJob.prototype.onError = function (err) {
  this.cb(err);
  this.destroy();
};
DecompressJob.prototype.onData = function (buffer) {
  if(this.maxPayload) {
      this.cumulativeBufferLength+=buffer.length;
      if(this.cumulativeBufferLength>this._maxPayload){
        this.cb({type:1009});
        this.destroy();
        return;
      }
  }
  this.buffers.push(buffer);
};

/**
 * Per-message Compression Extensions implementation
 */

function PerMessageDeflate(options, isServer,maxPayload) {
  if (this instanceof PerMessageDeflate === false) {
    throw new TypeError("Classes can't be function-called");
  }

  this._options = options || {};
  this._isServer = !!isServer;
  this._inflate = null;
  this._deflate = null;
  this.params = null;
  this._maxPayload = maxPayload || 0;
}

/**
 * Create extension parameters offer
 *
 * @api public
 */

PerMessageDeflate.prototype.offer = function() {
  var params = {};
  if (this._options.serverNoContextTakeover) {
    params.server_no_context_takeover = true;
  }
  if (this._options.clientNoContextTakeover) {
    params.client_no_context_takeover = true;
  }
  if (this._options.serverMaxWindowBits) {
    params.server_max_window_bits = this._options.serverMaxWindowBits;
  }
  if (this._options.clientMaxWindowBits) {
    params.client_max_window_bits = this._options.clientMaxWindowBits;
  } else if (this._options.clientMaxWindowBits == null) {
    params.client_max_window_bits = true;
  }
  return params;
};

/**
 * Accept extension offer
 *
 * @api public
 */

PerMessageDeflate.prototype.accept = function(paramsList) {
  paramsList = this.normalizeParams(paramsList);

  var params;
  if (this._isServer) {
    params = this.acceptAsServer(paramsList);
  } else {
    params = this.acceptAsClient(paramsList);
  }

  this.params = params;
  return params;
};

/**
 * Releases all resources used by the extension
 *
 * @api public
 */

PerMessageDeflate.prototype.cleanup = function() {
  if (this._inflate) {
    if (this._inflate.writeInProgress) {
      this._inflate.pendingClose = true;
    } else {
      if (this._inflate.close) this._inflate.close();
      this._inflate = null;
    }
  }
  if (this._deflate) {
    if (this._deflate.writeInProgress) {
      this._deflate.pendingClose = true;
    } else {
      if (this._deflate.close) this._deflate.close();
      this._deflate = null;
    }
  }
};

/**
 * Accept extension offer from client
 *
 * @api private
 */

PerMessageDeflate.prototype.acceptAsServer = function(paramsList) {
  var accepted = {};
  var result = paramsList.some(function(params) {
    accepted = {};
    if (this._options.serverNoContextTakeover === false && params.server_no_context_takeover) {
      return;
    }
    if (this._options.serverMaxWindowBits === false && params.server_max_window_bits) {
      return;
    }
    if (typeof this._options.serverMaxWindowBits === 'number' &&
        typeof params.server_max_window_bits === 'number' &&
        this._options.serverMaxWindowBits > params.server_max_window_bits) {
      return;
    }
    if (typeof this._options.clientMaxWindowBits === 'number' && !params.client_max_window_bits) {
      return;
    }

    if (this._options.serverNoContextTakeover || params.server_no_context_takeover) {
      accepted.server_no_context_takeover = true;
    }
    if (this._options.clientNoContextTakeover) {
      accepted.client_no_context_takeover = true;
    }
    if (this._options.clientNoContextTakeover !== false && params.client_no_context_takeover) {
      accepted.client_no_context_takeover = true;
    }
    if (typeof this._options.serverMaxWindowBits === 'number') {
      accepted.server_max_window_bits = this._options.serverMaxWindowBits;
    } else if (typeof params.server_max_window_bits === 'number') {
      accepted.server_max_window_bits = params.server_max_window_bits;
    }
    if (typeof this._options.clientMaxWindowBits === 'number') {
      accepted.client_max_window_bits = this._options.clientMaxWindowBits;
    } else if (this._options.clientMaxWindowBits !== false && typeof params.client_max_window_bits === 'number') {
      accepted.client_max_window_bits = params.client_max_window_bits;
    }
    return true;
  }, this);

  if (!result) {
    throw new Error('Doesn\'t support the offered configuration');
  }

  return accepted;
};

/**
 * Accept extension response from server
 *
 * @api private
 */

PerMessageDeflate.prototype.acceptAsClient = function(paramsList) {
  var params = paramsList[0];
  if (this._options.clientNoContextTakeover != null) {
    if (this._options.clientNoContextTakeover === false && params.client_no_context_takeover) {
      throw new Error('Invalid value for "client_no_context_takeover"');
    }
  }
  if (this._options.clientMaxWindowBits != null) {
    if (this._options.clientMaxWindowBits === false && params.client_max_window_bits) {
      throw new Error('Invalid value for "client_max_window_bits"');
    }
    if (typeof this._options.clientMaxWindowBits === 'number' &&
        (!params.client_max_window_bits || params.client_max_window_bits > this._options.clientMaxWindowBits)) {
      throw new Error('Invalid value for "client_max_window_bits"');
    }
  }
  return params;
};

/**
 * Normalize extensions parameters
 *
 * @api private
 */

PerMessageDeflate.prototype.normalizeParams = function(paramsList) {
  return paramsList.map(function(params) {
    Object.keys(params).forEach(function(key) {
      var value = params[key];
      if (value.length > 1) {
        throw new Error('Multiple extension parameters for ' + key);
      }

      value = value[0];

      switch (key) {
      case 'server_no_context_takeover':
      case 'client_no_context_takeover':
        if (value !== true) {
          throw new Error('invalid extension parameter value for ' + key + ' (' + value + ')');
        }
        params[key] = true;
        break;
      case 'server_max_window_bits':
      case 'client_max_window_bits':
        if (typeof value === 'string') {
          value = parseInt(value, 10);
          if (!~AVAILABLE_WINDOW_BITS.indexOf(value)) {
            throw new Error('invalid extension parameter value for ' + key + ' (' + value + ')');
          }
        }
        if (!this._isServer && value === true) {
          throw new Error('Missing extension parameter value for ' + key);
        }
        params[key] = value;
        break;
      default:
        throw new Error('Not defined extension parameter (' + key + ')');
      }
    }, this);
    return params;
  }, this);
};

/**
 * Decompress message
 *
 * @api public
 */


PerMessageDeflate.prototype.decompress = function (data, fin, callback) {
  if (!this._inflate) {
    this._inflate = new DecompressJob(this);
  }
  this._inflate.write(data, fin, callback);
};

/**
 * Compress message
 *
 * @api public
 */

PerMessageDeflate.prototype.compress = function (data, fin, callback) {
  if (!this._deflate) {
    this._deflate = new CompressJob(this);
  }
  this._deflate.write(data, fin, callback);
};

module.exports = PerMessageDeflate;
