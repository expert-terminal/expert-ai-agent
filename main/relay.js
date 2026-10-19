// WebSocket client for the pairing relay (expert-ai-link's PairingRoom Durable Object).
// This is the remote-pairing path — and now also the GUARANTEED fallback for
// same-WiFi pairing: the phone's QR always carries this relay tunnel URL, so even
// when LAN discovery fails (bad AP isolation, cleartext blocked, firewall, slow
// response burning the one-time qr_id) there is still a working way in. It does NOT
// run any agent logic itself — pi-server (the real Pico backend) does that; this is
// a pure HTTP proxy from the relay to the local pi-server.
const WebSocket = require('ws');
const crypto = require('node:crypto');
const { PI_SERVER_PORT } = require('./pi-server');

const RELAY_BASE = 'link.ssv.asia'; // custom domain (verified 2026-08-29); was expert-ai-link.arthouse.workers.dev
const RELAY_WS_URL = `wss://${RELAY_BASE}/pair/ws`;

// Reconnect with exponential backoff + jitter instead of a fixed 3s hammer — a
// relay outage or a laptop resuming from sleep shouldn't produce a tight reconnect
// loop, and the jitter stops every desktop in the field from retrying in lockstep.
const RECONNECT_MIN_MS = 3000;
const RECONNECT_MAX_MS = 30000;

// App-level WS heartbeat. `ws` sockets die silently on a dropped route (Wi-Fi
// change, NAT timeout) — no 'close' fires for minutes. Without this the desktop
// looks "connected" while the relay has already dropped it, and every scanned QR
// tunnels into a dead socket -> phone hangs on "waiting for approval". Ping every
// PING_INTERVAL_MS; if no pong comes back within PONG_TIMEOUT_MS, force a reconnect.
const PING_INTERVAL_MS = 20000;
const PONG_TIMEOUT_MS = 10000;

// End-to-end registration check. The relay's room can drop this desktop's
// registration (DO eviction, hibernation, a relay redeploy) WITHOUT closing the
// socket — it stays open and still answers ping/pong, so the heartbeat above sees
// nothing wrong, yet every scanned QR that falls back to the relay gets a 503
// "Desktop is not connected". The only reliable detector is to actually round-trip
// through the public tunnel URL and see if it comes back. First check runs shortly
// after connect (catches "registered on paper, not really"), then periodically.
const REG_CHECK_FIRST_MS = 3000;
// Adaptive interval — frequent only when a pairing is actually expected, relaxed
// in steady state so the health round-trip (one Worker + one Durable Object
// request each time) doesn't nibble at the Cloudflare free-tier daily budget.
// setActive() switches between them.
const REG_CHECK_INTERVAL_ACTIVE_MS = 15000;   // QR on screen / not yet paired
const REG_CHECK_INTERVAL_IDLE_MS = 120000;    // a phone is paired — tunnel traffic already proves liveness
const REG_CHECK_TIMEOUT_MS = 8000;
// If isReady() is consulted (Settings polls it every ~5s) and the last good
// round-trip is older than this, kick a fresh check in the background so a
// silently-dropped registration is caught within seconds, not on the next interval.
const REG_STALE_MS = 25000;
const REG_HEALTH_PATH = '/__relay_health';

// Cap on how long we wait for the local pi-server to answer a tunneled request.
// The phone's own pairing call times out around 4s; a hung fetch here (pi-server
// mid-restart, port not yet bound) must not pin the tunnel open past that.
const TUNNEL_FETCH_TIMEOUT_MS = 10000;

function generatePairingCode() {
  // 8 chars, unambiguous alphabet (no 0/O/1/I). Always uppercase so the code that
  // goes into the QR and the code the relay registers under can never differ by case.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 8; i++) code += alphabet[crypto.randomInt(alphabet.length)];
  return code;
}

class RelayClient {
  constructor({ store, onStatusChange, onReady }) {
    this.store = store;
    this.onStatusChange = onStatusChange || (() => {});
    this.onReady = onReady || (() => {});
    this.ws = null;
    this.stopped = false;
    this._attempts = 0;
    this._reconnectTimer = null;
    this._pingTimer = null;
    this._pongTimer = null;
    this._alive = false;
    this._regFirstTimer = null;
    this._regTimer = null;
    this._regInFlight = false;
    this._regConfirmed = false;
    this._lastRegOk = 0;
    this._regIntervalMs = REG_CHECK_INTERVAL_ACTIVE_MS;
  }

  /** Tray tells us whether a pairing is expected soon (active = QR shown / not yet
   *  paired) so registration checks can slow right down once a phone is connected. */
  setActive(active) {
    const next = active ? REG_CHECK_INTERVAL_ACTIVE_MS : REG_CHECK_INTERVAL_IDLE_MS;
    if (next === this._regIntervalMs) return;
    this._regIntervalMs = next;
    if (this._regTimer && this.ws && this.ws.readyState === WebSocket.OPEN) {
      clearInterval(this._regTimer);
      const ws = this.ws;
      this._regTimer = setInterval(() => this._verifyRegistration(ws), this._regIntervalMs);
    }
  }

  start() {
    this.stopped = false;
    this._attempts = 0;
    this._connect();
  }

  stop() {
    this.stopped = true;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this._stopHeartbeat();
    if (this.ws) {
      try { this.ws.close(); } catch { /* already closing */ }
    }
  }

  /** True only when the relay socket is genuinely open and registered — i.e. a QR
   *  that carries the relay tunnel URL will actually reach this desktop right now.
   *  index.js gates QR emission on this so it never ships a relay URL into a dead
   *  socket. */
  isReady() {
    const ok = !!this.ws && this.ws.readyState === WebSocket.OPEN && this._regConfirmed;
    // Opportunistic freshness: if we're being asked whether the relay is usable
    // and our last confirmed round-trip is stale, verify again now (fire & forget).
    if (ok && !this._regInFlight && Date.now() - (this._lastRegOk || 0) > REG_STALE_MS) {
      this._verifyRegistration(this.ws);
    }
    return ok;
  }

  getCode() {
    let pairing = this.store.get('pairing');
    if (!pairing || !pairing.code) {
      pairing = { code: generatePairingCode() };
      this.store.set('pairing', pairing);
    }
    return String(pairing.code).toUpperCase();
  }

  getTunnelUrl() {
    return `https://${RELAY_BASE}/tunnel/${this.getCode()}`;
  }

  rotateCode() {
    const pairing = { code: generatePairingCode() };
    this.store.set('pairing', pairing);
    // Reconnect under the new code immediately. _connect() reads getCode() fresh.
    if (this.ws) {
      try { this.ws.close(); } catch { /* already closing */ }
    } else {
      this._connect();
    }
    return pairing.code;
  }

  _connect() {
    if (this.stopped) return;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    const code = this.getCode();
    const url = `${RELAY_WS_URL}?code=${encodeURIComponent(code)}&role=desktop`;
    this.onStatusChange('connecting');

    let ws;
    try {
      ws = new WebSocket(url);
    } catch {
      this.onStatusChange('disconnected');
      this._scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.on('open', () => {
      if (this.ws !== ws) return;
      this._attempts = 0; // reset backoff only after a real successful connect
      this._regConfirmed = false;
      this.onStatusChange('connected');
      this._startHeartbeat(ws);
      this._startRegistrationChecks(ws);
    });

    ws.on('pong', () => {
      if (this.ws === ws) this._alive = true;
    });

    ws.on('message', async (raw) => {
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

    ws.on('close', () => {
      if (this.ws === ws) {
        this.ws = null;
        this._regConfirmed = false;
        this._stopHeartbeat();
        this.onStatusChange('disconnected');
      }
      if (!this.stopped) this._scheduleReconnect();
    });

    ws.on('error', () => {
      // 'close' fires right after — reconnect is handled there.
    });
  }

  _scheduleReconnect() {
    if (this.stopped || this._reconnectTimer) return;
    const ceil = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** this._attempts);
    // Full jitter across [ceil/2, ceil]: still backs off, but never a thundering herd.
    const delay = Math.round(ceil / 2 + Math.random() * (ceil / 2));
    this._attempts += 1;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._connect();
    }, delay);
  }

  _startHeartbeat(ws) {
    this._stopHeartbeat();
    this._alive = true;
    this._pingTimer = setInterval(() => {
      if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) return;
      if (!this._alive) {
        // Missed the previous pong — the socket is a zombie. Kill it; 'close'
        // will fire and _scheduleReconnect() takes over.
        try { ws.terminate(); } catch { /* nothing to do */ }
        return;
      }
      this._alive = false;
      try { ws.ping(); } catch { /* pipe gone — next tick terminates */ }
    }, PING_INTERVAL_MS);
  }

  _stopHeartbeat() {
    if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; }
    if (this._pongTimer) { clearTimeout(this._pongTimer); this._pongTimer = null; }
    if (this._regFirstTimer) { clearTimeout(this._regFirstTimer); this._regFirstTimer = null; }
    if (this._regTimer) { clearInterval(this._regTimer); this._regTimer = null; }
  }

  _startRegistrationChecks(ws) {
    if (this._regFirstTimer) clearTimeout(this._regFirstTimer);
    if (this._regTimer) clearInterval(this._regTimer);
    this._regFirstTimer = setTimeout(() => this._verifyRegistration(ws), REG_CHECK_FIRST_MS);
    this._regTimer = setInterval(() => this._verifyRegistration(ws), this._regIntervalMs);
  }

  /** Round-trips through the public tunnel URL back to ourselves. A 503 (or no
   *  response) means the relay is no longer routing this code to us even though the
   *  socket looks fine — recycle it so _connect() re-registers. The matching
   *  short-circuit for REG_HEALTH_PATH lives in _handleTunnelRequest(). */
  async _verifyRegistration(ws, isRetry) {
    if (this.stopped || this.ws !== ws || ws.readyState !== WebSocket.OPEN) return;
    if (this._regInFlight) return;
    this._regInFlight = true;
    const nonce = crypto.randomBytes(8).toString('hex');
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), REG_CHECK_TIMEOUT_MS);
    let ok = false;
    let detail = '';
    try {
      const res = await fetch(`https://${RELAY_BASE}/tunnel/${this.getCode()}${REG_HEALTH_PATH}`, {
        method: 'GET',
        headers: { 'x-relay-health': nonce },
        signal: ac.signal,
      });
      const body = await res.text();
      ok = res.status >= 200 && res.status < 500 && res.status !== 503 && body.includes(nonce);
      detail = `status ${res.status}`;
    } catch (err) {
      detail = err && err.name === 'AbortError' ? 'timeout' : ((err && err.message) || String(err));
    } finally {
      clearTimeout(timer);
      this._regInFlight = false;
    }

    if (this.stopped || this.ws !== ws || ws.readyState !== WebSocket.OPEN) return;

    if (ok) {
      this._lastRegOk = Date.now();
      if (!this._regConfirmed) {
        this._regConfirmed = true;
        console.log('[relay] registration confirmed — tunnel round-trip OK');
        this.onReady();
      }
      return;
    }

    // First failure: don't nuke a healthy socket over one blip — mark unconfirmed
    // (so the QR gate goes conservative) and re-check once quickly. Second failure
    // in a row: the relay really isn't routing to us — recycle so _connect()
    // re-registers.
    this._regConfirmed = false;
    if (!isRetry) {
      console.warn(`[relay] registration check failed (${detail}) — re-checking`);
      setTimeout(() => this._verifyRegistration(ws, true), 2000);
    } else {
      console.warn(`[relay] registration check failed again (${detail}) — recycling socket`);
      try { ws.terminate(); } catch { /* nothing to do */ }
    }
  }

  _send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  /** Forwards one tunneled HTTP request to the real, locally-running pi-server and
   *  sends its response back. Content-agnostic — a pure proxy. Hardened three ways
   *  over the naive version: hop-by-hop headers from the relay leg are stripped so
   *  fetch recomputes an accurate content-length (a stale one makes pi-server hang
   *  or 400 the pairing POST); an AbortController bounds the wait; and a single
   *  quick retry covers the common "relay reconnected a beat before pi-server
   *  finished binding :5454" race at startup. */
  async _handleTunnelRequest(msg) {
    // Our own registration probe (see _verifyRegistration) — answer it here, never
    // bother pi-server with it. Echo the nonce so the prober can confirm the loop.
    const healthNonce = msg.headers && (msg.headers['x-relay-health'] || msg.headers['X-Relay-Health']);
    if (msg.path === REG_HEALTH_PATH || healthNonce) {
      this._send({
        type: 'tunnel_response',
        id: msg.id,
        status: 200,
        headers: { 'content-type': 'text/plain' },
        body: `relay-ok ${healthNonce || ''}`.trim(),
      });
      return;
    }

    const url = `http://127.0.0.1:${PI_SERVER_PORT}${msg.path}`;
    const HOP_BY_HOP = new Set([
      'host', 'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
      'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-length', 'accept-encoding',
    ]);
    const headers = {};
    for (const [k, v] of Object.entries(msg.headers || {})) {
      if (!HOP_BY_HOP.has(k.toLowerCase())) headers[k] = v;
    }
    const reqBody = msg.body === undefined || msg.body === null || msg.method === 'GET' || msg.method === 'HEAD'
      ? undefined
      : msg.body;

    // fetch() itself only bounds connect + time-to-first-byte; the timer is cleared
    // the moment headers arrive, so a long-lived SSE stream is NOT killed by it.
    const doFetch = async () => {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), TUNNEL_FETCH_TIMEOUT_MS);
      try {
        return await fetch(url, { method: msg.method, headers, body: reqBody, signal: ac.signal });
      } finally {
        clearTimeout(timer);
      }
    };

    let res;
    try {
      try {
        res = await doFetch();
      } catch (err) {
        if (err && err.name === 'AbortError') throw err;
        // Connection refused / reset — pi-server may still be binding. One retry.
        await new Promise((r) => setTimeout(r, 500));
        res = await fetch(url, { method: msg.method, headers, body: reqBody });
      }
    } catch (err) {
      this._send({
        type: 'tunnel_response',
        id: msg.id,
        status: 502,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ error: `pi-server unreachable locally: ${err instanceof Error ? err.message : String(err)}` }),
      });
      return;
    }

    const outHeaders = {};
    res.headers.forEach((v, k) => { outHeaders[k] = v; });

    // Stream when the response is open-ended (Agent-mode chat SSE) — anything with
    // no Content-Length, or an explicit event-stream / chunked marker. Everything
    // else (pairing, session, workspace list: small bounded JSON) takes the simple
    // one-shot path so the relay's fast request/response flow is unchanged.
    const ctype = (res.headers.get('content-type') || '').toLowerCase();
    const isStream =
      ctype.includes('text/event-stream') ||
      (res.headers.get('transfer-encoding') || '').toLowerCase().includes('chunked') ||
      res.headers.get('content-length') == null;

    if (!isStream || !res.body) {
      let body;
      try { body = await res.text(); } catch (e) {
        this._send({ type: 'tunnel_error', id: msg.id, message: String((e && e.message) || e) });
        return;
      }
      this._send({ type: 'tunnel_response', id: msg.id, status: res.status, headers: outHeaders, body });
      return;
    }

    // --- streaming path ---
    this._send({ type: 'tunnel_head', id: msg.id, status: res.status, headers: outHeaders });
    const reader = res.body.getReader();
    let pending = [];
    let pendingLen = 0;
    let flushTimer = null;
    const flush = () => {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      if (!pendingLen) return;
      const merged = Buffer.concat(pending, pendingLen);
      pending = [];
      pendingLen = 0;
      this._send({ type: 'tunnel_chunk', id: msg.id, data: merged.toString('base64') });
    };
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (this.ws && this.ws.readyState !== WebSocket.OPEN) { try { await reader.cancel(); } catch {} break; }
        pending.push(Buffer.from(value));
        pendingLen += value.length;
        // Coalesce: flush on 16KB, else on a 50ms timer. Keeps WS frames (and the
        // relay DO's per-message billed wakeups) to a handful per turn instead of
        // one per token, with no user-visible latency.
        if (pendingLen >= 16384) flush();
        else if (!flushTimer) flushTimer = setTimeout(flush, 50);
      }
      flush();
      this._send({ type: 'tunnel_end', id: msg.id });
    } catch (err) {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      this._send({ type: 'tunnel_error', id: msg.id, message: String((err && err.message) || err) });
    }
  }
}

module.exports = { RelayClient, generatePairingCode };
