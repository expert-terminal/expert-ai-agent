// WebSocket client for the pairing relay (expert-ai-link's PairingRoom Durable Object).
// This is ONLY the remote-pairing fallback now — same-WiFi pairing talks to pi-server
// directly over LAN (pi-server's own QR flow), and this relay just forwards HTTP
// requests to the local pi-server when the phone isn't on the same network. It does
// NOT run any agent logic itself — pi-server (the real Pico backend) does that.
const WebSocket = require('ws');
const crypto = require('node:crypto');
const { PI_SERVER_PORT } = require('./pi-server');

const RELAY_BASE = 'expert-ai-link.arthouse.workers.dev';
const RELAY_WS_URL = `wss://${RELAY_BASE}/pair/ws`;
const RECONNECT_DELAY_MS = 3000;

function generatePairingCode() {
  // 8 chars, unambiguous alphabet (no 0/O/1/I).
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 8; i++) code += alphabet[crypto.randomInt(alphabet.length)];
  return code;
}

class RelayClient {
  constructor({ store, onStatusChange }) {
    this.store = store;
    this.onStatusChange = onStatusChange || (() => {});
    this.ws = null;
    this.stopped = false;
  }

  start() {
    this.stopped = false;
    this._connect();
  }

  stop() {
    this.stopped = true;
    if (this.ws) this.ws.close();
  }

  getCode() {
    let pairing = this.store.get('pairing');
    if (!pairing || !pairing.code) {
      pairing = { code: generatePairingCode() };
      this.store.set('pairing', pairing);
    }
    return pairing.code;
  }

  getTunnelUrl() {
    return `https://${RELAY_BASE}/tunnel/${this.getCode()}`;
  }

  rotateCode() {
    const pairing = { code: generatePairingCode() };
    this.store.set('pairing', pairing);
    if (this.ws) this.ws.close();
    return pairing.code;
  }

  _connect() {
    if (this.stopped) return;
    const code = this.getCode();
    const url = `${RELAY_WS_URL}?code=${encodeURIComponent(code)}&role=desktop`;
    this.onStatusChange('connecting');
    this.ws = new WebSocket(url);

    this.ws.on('open', () => {
      this.onStatusChange('connected');
    });

    this.ws.on('message', async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === 'status') {
        this.onStatusChange(msg.peerConnected ? 'paired' : 'connected');
        return;
      }
      if (msg.type === 'tunnel_request') {
        await this._handleTunnelRequest(msg);
      }
    });

    this.ws.on('close', () => {
      this.onStatusChange('disconnected');
      if (!this.stopped) setTimeout(() => this._connect(), RECONNECT_DELAY_MS);
    });

    this.ws.on('error', () => {
      // 'close' fires right after — reconnect handled there.
    });
  }

  _send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  /** Forwards one tunneled HTTP request to the real, locally-running pi-server and
   *  sends its response back. Content-agnostic — doesn't know or care what pi-server's
   *  API shape is, it's a pure proxy. */
  async _handleTunnelRequest(msg) {
    try {
      const res = await fetch(`http://127.0.0.1:${PI_SERVER_PORT}${msg.path}`, {
        method: msg.method,
        headers: msg.headers,
        body: msg.body,
      });
      const headers = {};
      res.headers.forEach((v, k) => { headers[k] = v; });
      const body = await res.text();
      this._send({ type: 'tunnel_response', id: msg.id, status: res.status, headers, body });
    } catch (err) {
      this._send({
        type: 'tunnel_response',
        id: msg.id,
        status: 502,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ error: `pi-server unreachable locally: ${err instanceof Error ? err.message : String(err)}` }),
      });
    }
  }
}

module.exports = { RelayClient, generatePairingCode };
