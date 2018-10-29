'use strict';

const {EventEmitter} = require('events')

import logger from 'lib/logger'
const rlp = require('rlp-encoding')
const util = require('./util')
const BufferList = require('bl')
const ms = require('ms')
const Buffer = require('safe-buffer').Buffer

const {int2buffer, buffer2int} = require('./util')

const ECIES = require('./ecies')

const BASE_PROTOCOL_VERSION = 4
const BASE_PROTOCOL_LENGTH = 16

const PING_INTERVAL = ms('15s')

const PREFIXES = {
  HELLO: 0x00,
  DISCONNECT: 0x01,
  PING: 0x02,
  PONG: 0x03,
}

/** Peer */
class Peer extends EventEmitter {
  constructor(options) {
    super()

    // hello data
    this._clientId = options.clientId
    this._capabilities = options.capabilities
    console.log('options.port', options.port)
    this._port = options.port
    this._id = options.id
    this._remoteClientIdFilter = options.remoteClientIdFilter

    // ECIES session
    this._remoteId = options.remoteId
    this._EIP8 = options.EIP8 !== undefined ? options.EIP8 : true
    this._eciesSession = new ECIES(options.privateKey, this._id, this._remoteId)

    // Auth, Ack, Header, Body
    this._state = 'Auth'
    this._weHello = null
    this._hello = null
    this._nextPacketSize = 307

    // socket
    this._socket = options.socket
    this._socket.on('error', (err) => this.emit('error', err))
    this._socket.once('close', () => {
      clearInterval(this._pingIntervalId)
      clearTimeout(this._pingTimeoutId)

      this._closed = true
      if (this._connected) this.emit('close', this._disconnectReason, this._disconnectWe)
    })

    const bl = new BufferList()
    this._socket.on('data', (data) => {
      if (this._closed) return
      bl.append(data)
      while (bl.length >= this._nextPacketSize) {
        const bytesCount = this._nextPacketSize
        const parseData = bl.slice(0, bytesCount)
        try {
          if (this._state === 'Auth') {
            if (!this._eciesSession._gotEIP8Auth) {
              try {
                this._eciesSession.parseAuthPlain(parseData)
              } catch (err) {
                this._eciesSession._gotEIP8Auth = true
                this._nextPacketSize = util.buffer2int(data.slice(0, 2)) + 2
                continue
              }
            } else {
              this._eciesSession.parseAuthEIP8(parseData)
            }
            this._state = 'Header'
            this._nextPacketSize = 32
            process.nextTick(() => this._sendAck())
          } else if (this._state === 'Ack') {
            if (!this._eciesSession._gotEIP8Ack) {
              try {
                this._eciesSession.parseAckPlain(parseData)
                logger.info(`Received ack (old format) from ${this._socket.remoteAddress}:${this._socket.remotePort}`)
              } catch (err) {
                this._eciesSession._gotEIP8Ack = true
                this._nextPacketSize = util.buffer2int(data.slice(0, 2)) + 2
                continue
              }
            } else {
              this._eciesSession.parseAckEIP8(parseData)
              logger.info(`Received ack (EIP8) from ${this._socket.remoteAddress}:${this._socket.remotePort}`)
            }
            this._state = 'Header';
            this._nextPacketSize = 32;
            process.nextTick(() => this._sendHello())
          } else {
            this._parsePacketContent(parseData)
          }
        } catch (err) {
          this.emit('error', err);
        }
        bl.consume(bytesCount);
      }
    });

    this._connected = false;
    this._closed = false;
    this._disconnectReason = null;
    this._disconnectWe = null;
    this._pingIntervalId = null;
    this._pingTimeout = options.timeout;
    this._pingTimeoutId = null;

    // sub-protocols
    this._protocols = [];

    // send AUTH if outgoing connection
    if (this._remoteId !== null) this._sendAuth();
  }

  _parseSocketData(data) {}

  _parsePacketContent(data) {
    switch (this._state) {
      case 'Header':
        logger.info(`Received header ${this._socket.remoteAddress}:${this._socket.remotePort}`);
        const size = this._eciesSession.parseHeader(data);
        this._state = 'Body';
        this._nextPacketSize = size + 16;
        if (size % 16 > 0) this._nextPacketSize += 16 - size % 16;
        break;

      case 'Body':
        const body = this._eciesSession.parseBody(data);
        logger.info(`Received body ${this._socket.remoteAddress}:${this._socket.remotePort} ${body.toString('hex')}`);

        this._state = 'Header';
        this._nextPacketSize = 32;

        // RLP hack
        let code = body[0];
        if (code === 0x80) code = 0;

        if (code !== PREFIXES.HELLO && code !== PREFIXES.DISCONNECT && this._hello === null) {
          return this.disconnect(Peer.DISCONNECT_REASONS.PROTOCOL_ERROR);
        }

        const obj = this._getProtocol(code);
        if (obj === undefined) return this.disconnect(Peer.DISCONNECT_REASONS.PROTOCOL_ERROR);

        const msgCode = code - obj.offset;
        const prefix = this.getMsgPrefix(msgCode);
        logger.info(`Received ${prefix} (message code: ${code} - ${obj.offset} = ${msgCode}) ${this._socket.remoteAddress}:${this._socket.remotePort}`);

        try {
          obj.protocol._handleMessage(msgCode, body.slice(1));
        } catch (err) {
          this.disconnect(Peer.DISCONNECT_REASONS.SUBPROTOCOL_ERROR);
          this.emit('error', err);
        }

        break;
    }
  }

  _getProtocol(code) {
    if (code < BASE_PROTOCOL_LENGTH) return { protocol: this, offset: 0 };
    var _iteratorNormalCompletion = true;
    var _didIteratorError = false;
    var _iteratorError = undefined;

    try {
      for (var _iterator = this._protocols[Symbol.iterator](), _step; !(_iteratorNormalCompletion = (_step = _iterator.next()).done); _iteratorNormalCompletion = true) {
        let obj = _step.value;

        if (code >= obj.offset && code < obj.offset + obj.length) return obj;
      }
    } catch (err) {
      _didIteratorError = true;
      _iteratorError = err;
    } finally {
      try {
        if (!_iteratorNormalCompletion && _iterator.return) {
          _iterator.return();
        }
      } finally {
        if (_didIteratorError) {
          throw _iteratorError;
        }
      }
    }
  }

  _handleMessage(code, msg) {
    const payload = rlp.decode(msg);
    switch (code) {
    case PREFIXES.HELLO:
      this._hello = {
        protocolVersion: buffer2int(payload[0]),
        clientId: payload[1].toString(),
        capabilities: payload[2].map(item => {
          return { name: item[0].toString(), version: buffer2int(item[1]) };
        }),
        port: buffer2int(payload[3]),
        id: payload[4]
      };

      if (this._remoteId === null) {
        this._remoteId = Buffer.from(this._hello.id);
      } else if (!this._remoteId.equals(this._hello.id)) {
        return this.disconnect(Peer.DISCONNECT_REASONS.INVALID_IDENTITY);
      }

      if (this._remoteClientIdFilter) {
        var _iteratorNormalCompletion2 = true
        var _didIteratorError2 = false
        var _iteratorError2 = undefined

        try {
          for (var _iterator2 = this._remoteClientIdFilter[Symbol.iterator](), _step2; !(_iteratorNormalCompletion2 = (_step2 = _iterator2.next()).done); _iteratorNormalCompletion2 = true) {
            let filterStr = _step2.value;

            if (this._hello.clientId.toLowerCase().includes(filterStr.toLowerCase())) {
              return this.disconnect(Peer.DISCONNECT_REASONS.USELESS_PEER);
            }
          }
        } catch (err) {
          _didIteratorError2 = true;
          _iteratorError2 = err;
        } finally {
          try {
            if (!_iteratorNormalCompletion2 && _iterator2.return) {
              _iterator2.return();
            }
          } finally {
            if (_didIteratorError2) {
              throw _iteratorError2;
            }
          }
        }
      }

      const shared = {}
      var _iteratorNormalCompletion3 = true
      var _didIteratorError3 = false
      var _iteratorError3 = undefined

      try {
        for (var _iterator3 = this._hello.capabilities[Symbol.iterator](), _step3; !(_iteratorNormalCompletion3 = (_step3 = _iterator3.next()).done); _iteratorNormalCompletion3 = true) {
          let item = _step3.value;
          var _iteratorNormalCompletion4 = true;
          var _didIteratorError4 = false;
          var _iteratorError4 = undefined;

          try {
            for (var _iterator4 = this._capabilities[Symbol.iterator](), _step4; !(_iteratorNormalCompletion4 = (_step4 = _iterator4.next()).done); _iteratorNormalCompletion4 = true) {
              let obj = _step4.value;

              if (obj.name !== item.name || obj.version !== item.version) continue;
              if (shared[obj.name] && shared[obj.name].version > obj.version) continue;
              shared[obj.name] = obj;
            }
          } catch (err) {
            _didIteratorError4 = true;
            _iteratorError4 = err;
          } finally {
            try {
              if (!_iteratorNormalCompletion4 && _iterator4.return) {
                _iterator4.return();
              }
            } finally {
              if (_didIteratorError4) {
                throw _iteratorError4;
              }
            }
          }
        }
      } catch (err) {
        _didIteratorError3 = true;
        _iteratorError3 = err;
      } finally {
        try {
          if (!_iteratorNormalCompletion3 && _iterator3.return) {
            _iterator3.return();
          }
        } finally {
          if (_didIteratorError3) {
            throw _iteratorError3;
          }
        }
      }

      let offset = BASE_PROTOCOL_LENGTH;
      this._protocols = Object.keys(shared).map(key => shared[key]).sort((obj1, obj2) => obj1.name < obj2.name ? -1 : 1).map(obj => {
        const _offset = offset;
        offset += obj.length;

        const SubProtocol = obj.constructor;
        const protocol = new SubProtocol(obj.version, this, (code, data) => {
          if (code > obj.length) throw new Error('Code out of range');
          this._sendMessage(_offset + code, data);
        });

        return { protocol, offset: _offset, length: obj.length };
      });

      if (this._protocols.length === 0) {
        return this.disconnect(Peer.DISCONNECT_REASONS.USELESS_PEER);
      }

      this._connected = true
      this._pingIntervalId = setInterval(() => this._sendPing(), PING_INTERVAL);
      if (this._weHello) {
        this.emit('connect')
      }
      break

    case PREFIXES.DISCONNECT:
      this._closed = true
      this._disconnectReason = payload[0].length === 0 ? 0 : payload[0][0]
      this._disconnectWe = false
      this._socket.end()
      break

    case PREFIXES.PING:
      this._sendPong()
      break

    case PREFIXES.PONG:
      clearTimeout(this._pingTimeoutId)
      break
    }
  }

  _sendAuth() {
    if (this._closed) return;
    logger.info(`Send auth (EIP8: ${this._EIP8}) to ${this._socket.remoteAddress}:${this._socket.remotePort}`);
    if (this._EIP8) {
      this._socket.write(this._eciesSession.createAuthEIP8());
    } else {
      this._socket.write(this._eciesSession.createAuthNonEIP8());
    }
    this._state = 'Ack';
    this._nextPacketSize = 210;
  }

  _sendAck() {
    if (this._closed) return;
    logger.info(`Send ack (EIP8: ${this._eciesSession._gotEIP8Auth}) to ${this._socket.remoteAddress}:${this._socket.remotePort}`);
    if (this._eciesSession._gotEIP8Auth) {
      this._socket.write(this._eciesSession.createAckEIP8());
    } else {
      this._socket.write(this._eciesSession.createAckOld());
    }
    this._state = 'Header';
    this._nextPacketSize = 32;
    this._sendHello();
  }

  _sendMessage(code, data) {
    if (this._closed) return false;
    const msg = Buffer.concat([rlp.encode(code), data]);
    this._socket.write(this._eciesSession.createHeader(msg.length));
    this._socket.write(this._eciesSession.createBody(msg));
    return true;
  }

  _sendHello() {
    logger.info(`Send HELLO to ${this._socket.remoteAddress}:${this._socket.remotePort}`);
    console.log('port', this._port);
    const payload = [int2buffer(BASE_PROTOCOL_VERSION), this._clientId, this._capabilities.map(obj => [Buffer.from(obj.name), int2buffer(obj.version)]), this._port === null ? Buffer.allocUnsafe(0) : int2buffer(this._port), this._id];

    if (!this._closed) {
      if (this._sendMessage(PREFIXES.HELLO, rlp.encode(payload))) {
        this._weHello = payload;
      }
      if (this._hello) {
        this.emit('connect');
      }
    }
  }

  _sendPing() {
    logger.info(`Send PING to ${this._socket.remoteAddress}:${this._socket.remotePort}`);
    const data = rlp.encode([]);
    if (!this._sendMessage(PREFIXES.PING, data)) return;

    clearTimeout(this._pingTimeoutId);
    this._pingTimeoutId = setTimeout(() => {
      this.disconnect(Peer.DISCONNECT_REASONS.TIMEOUT);
    }, this._pingTimeout);
  }

  _sendPong() {
    logger.info(`Send PONG to ${this._socket.remoteAddress}:${this._socket.remotePort}`);
    const data = rlp.encode([]);
    this._sendMessage(PREFIXES.PONG, data);
  }

  _sendDisconnect(reason) {
    console.trace('im here');
    logger.info(`Send DISCONNECT to ${this._socket.remoteAddress}:${this._socket.remotePort} (reason: ${this.getDisconnectPrefix(reason)})`);
    const data = rlp.encode(reason);
    if (!this._sendMessage(PREFIXES.DISCONNECT, data)) return;

    this._disconnectReason = reason
    this._disconnectWe = true
    this._closed = true
    setTimeout(() => this._socket.end(), ms('2s'))
  }

  getId() {
    if (this._remoteId === null) return null
    return Buffer.from(this._remoteId)
  }

  getHelloMessage() {
    return this._hello
  }

  getProtocols() {
    return this._protocols.map(obj => obj.protocol)
  }

  getMsgPrefix(code) {
    return Object.keys(PREFIXES).find(key => PREFIXES[key] === code)
  }

  getDisconnectPrefix(code) {
    return Object.keys(Peer.DISCONNECT_REASONS).find(key => Peer.DISCONNECT_REASONS[key] === code)
  }

  disconnect(reason = Peer.DISCONNECT_REASONS.DISCONNECT_REQUESTED) {
    this._sendDisconnect(reason);
  }
}

Peer.DISCONNECT_REASONS = {
  DISCONNECT_REQUESTED: 0x00,
  NETWORK_ERROR: 0x01,
  PROTOCOL_ERROR: 0x02,
  USELESS_PEER: 0x03,
  TOO_MANY_PEERS: 0x04,
  ALREADY_CONNECTED: 0x05,
  INCOMPATIBLE_VERSION: 0x06,
  INVALID_IDENTITY: 0x07,
  CLIENT_QUITTING: 0x08,
  UNEXPECTED_IDENTITY: 0x09,
  SAME_IDENTITY: 0x0a,
  TIMEOUT: 0x0b,
  SUBPROTOCOL_ERROR: 0x10
};
module.exports = Peer;