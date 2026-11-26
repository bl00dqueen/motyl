'use strict';

/**
 * Минимальная реализация WebSocket (RFC 6455) на голом Node.js.
 * Работает и как сервер (поверх события 'upgrade'), и как клиент.
 * Внешние зависимости не нужны.
 */

const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_FRAME = 2 * 1024 * 1024;

function acceptKey(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

class WSConnection extends EventEmitter {
  /**
   * @param {import('net').Socket} socket
   * @param {{ mask?: boolean }} [options] клиент обязан маскировать кадры
   */
  constructor(socket, options = {}) {
    super();
    this.socket = socket;
    this.mask = !!options.mask;
    this.buffer = Buffer.alloc(0);
    this.closed = false;
    this.fragments = [];
    this.fragmentOpcode = 0;
    /** Кадры, пришедшие до подписки на 'message' (важно для клиента). */
    this._messageQueue = [];

    socket.setNoDelay(true);
    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('close', () => this._emitClose());
    socket.on('error', () => this._emitClose());
    socket.on('end', () => this._emitClose());
  }

  _emitClose(err) {
    if (this.closed) return;
    this.closed = true;
    this.emit('close', err);
  }

  _onData(chunk) {
    if (this.closed) return;
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    if (this.buffer.length > 8 * 1024 * 1024) {
      this.close(1009);
      return;
    }
    while (!this.closed) {
      let frame;
      try {
        frame = this._readFrame();
      } catch (err) {
        this.close(1002);
        return;
      }
      if (!frame) break;
      this._handleFrame(frame);
    }
  }

  _readFrame() {
    const buf = this.buffer;
    if (buf.length < 2) return null;

    const fin = (buf[0] & 0x80) !== 0;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let length = buf[1] & 0x7f;
    let offset = 2;

    if (length === 126) {
      if (buf.length < 4) return null;
      length = buf.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (buf.length < 10) return null;
      const high = buf.readUInt32BE(2);
      const low = buf.readUInt32BE(6);
      if (high !== 0) throw new Error('frame too large');
      length = low;
      offset = 10;
    }

    if (length > MAX_FRAME) throw new Error('frame too large');

    let maskKey = null;
    if (masked) {
      if (buf.length < offset + 4) return null;
      maskKey = buf.subarray(offset, offset + 4);
      offset += 4;
    }
    if (buf.length < offset + length) return null;

    let payload = buf.subarray(offset, offset + length);
    if (masked) {
      payload = Buffer.from(payload);
      for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i & 3];
    }
    this.buffer = buf.subarray(offset + length);
    return { fin, opcode, payload };
  }

  _handleFrame({ fin, opcode, payload }) {
    if (opcode === 0x8) { // close
      this.close(1000);
      return;
    }
    if (opcode === 0x9) { // ping
      this._sendFrame(0xa, payload);
      return;
    }
    if (opcode === 0xa) return; // pong

    if (opcode === 0x0) { // continuation
      if (!this.fragmentOpcode) return;
      this.fragments.push(payload);
      if (fin) {
        const data = Buffer.concat(this.fragments);
        const op = this.fragmentOpcode;
        this.fragments = [];
        this.fragmentOpcode = 0;
        this._deliver(op, data);
      }
      return;
    }

    if (opcode === 0x1 || opcode === 0x2) {
      if (!fin) {
        this.fragmentOpcode = opcode;
        this.fragments = [payload];
        return;
      }
      this._deliver(opcode, payload);
    }
  }

  _deliver(opcode, data) {
    if (opcode === 0x1) {
      const text = data.toString('utf8');
      if (this.listenerCount('message') === 0) {
        if (this._messageQueue.length < 1000) this._messageQueue.push(text);
        return;
      }
      this.emit('message', text);
    } else if (opcode === 0x2) {
      this.emit('binary', data);
    }
  }

  on(event, listener) {
    super.on(event, listener);
    if (event === 'message' && this._messageQueue.length) {
      const queue = this._messageQueue.splice(0);
      for (const item of queue) listener(item);
    }
    return this;
  }

  _sendFrame(opcode, payload) {
    if (this.closed) return false;
    const len = payload.length;
    const maskBit = this.mask ? 0x80 : 0;
    let header;

    if (len < 126) {
      header = Buffer.alloc(2);
      header[1] = maskBit | len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[1] = maskBit | 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = maskBit | 127;
      header.writeUInt32BE(0, 2);
      header.writeUInt32BE(len, 6);
    }
    header[0] = 0x80 | opcode;

    let out;
    if (this.mask) {
      const key = crypto.randomBytes(4);
      const masked = Buffer.alloc(len);
      for (let i = 0; i < len; i++) masked[i] = payload[i] ^ key[i & 3];
      out = Buffer.concat([header, key, masked]);
    } else {
      out = Buffer.concat([header, payload]);
    }

    try {
      this.socket.write(out);
      return true;
    } catch (err) {
      this._emitClose(err);
      return false;
    }
  }

  send(text) {
    return this._sendFrame(0x1, Buffer.from(String(text), 'utf8'));
  }

  ping() {
    return this._sendFrame(0x9, Buffer.alloc(0));
  }

  close(code = 1000) {
    if (this.closed) return;
    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(code, 0);
    this._sendFrame(0x8, payload);
    this.closed = true;
    try { this.socket.end(); } catch (err) { /* ignore */ }
    this.emit('close');
  }
}

/**
 * Подключает обработчик WebSocket-апгрейдов к http(s)-серверу.
 * @param {import('http').Server} server
 * @param {(conn: WSConnection, req: import('http').IncomingMessage) => void} onConnection
 */
function handleUpgrade(server, onConnection) {
  server.on('upgrade', (req, socket, head) => {
    const key = req.headers['sec-websocket-key'];
    const upgrade = String(req.headers.upgrade || '').toLowerCase();
    if (upgrade !== 'websocket' || !key) {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const headers = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${acceptKey(key)}`,
      '\r\n',
    ];
    socket.write(headers.join('\r\n'));

    const conn = new WSConnection(socket, { mask: false });
    if (head && head.length) conn._onData(head);
    onConnection(conn, req);
  });
}

/**
 * Открывает WebSocket-соединение с сервером.
 * @param {string} url ws:// или wss://
 * @param {{ headers?: Record<string,string>, timeout?: number }} [options]
 * @returns {Promise<WSConnection>}
 */
function connect(url, options = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (err) {
      reject(new Error('Некорректный WebSocket URL: ' + url));
      return;
    }
    if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
      reject(new Error('Ожидается ws:// или wss://'));
      return;
    }

    const secure = parsed.protocol === 'wss:';
    const lib = secure ? https : http;
    const req = lib.request({
      hostname: parsed.hostname,
      port: parsed.port || (secure ? 443 : 80),
      path: parsed.pathname + parsed.search,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
        'Sec-WebSocket-Version': '13',
        ...(options.headers || {}),
      },
      rejectUnauthorized: false,
    });

    const timeout = setTimeout(() => {
      req.destroy(new Error('Таймаут подключения к WebSocket'));
    }, options.timeout || 10000);
    if (timeout.unref) timeout.unref();

    req.on('upgrade', (res, socket, head) => {
      clearTimeout(timeout);
      const conn = new WSConnection(socket, { mask: true });
      if (head && head.length) conn._onData(head);
      resolve(conn);
    });
    req.on('response', (res) => {
      clearTimeout(timeout);
      res.resume();
      reject(new Error('Сервер отклонил WebSocket-соединение (HTTP ' + res.statusCode + ')'));
    });
    req.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    req.end();
  });
}

module.exports = { WSConnection, handleUpgrade, connect, acceptKey };
