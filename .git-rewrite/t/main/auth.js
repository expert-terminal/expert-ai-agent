// Device-login flow, ported from the real shipped CLI (expert-ai@0.6.2's bin/x.js) —
// same gateway, same /auth/start + /auth/poll calls, same session shape. This is what
// gives the tray app its OWN signed-in gateway session, so Agent mode bills against
// the same account/entitlement as Chat mode on the phone, no separate credential path.
const { shell } = require('electron');

const WORKER_URL = 'https://expert-ai-gateway.arthouse.workers.dev';
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;

async function api(method, path, body) {
  const r = await fetch(`${WORKER_URL}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await r.json(); } catch { /* non-JSON error body */ }
  return { ok: r.ok, status: r.status, data };
}

/** Starts device login for `email`, opens the Ghost verify page, and polls until the
 *  session is confirmed (or times out). Returns the same session shape lib/auth.ts
 *  produces on the phone: { token, email, entitlement, sessionExpires, ... }. */
async function deviceLogin(email, onStatus) {
  const start = await api('POST', '/auth/start', { email });
  if (!start.ok) {
    throw new Error(start.data?.error || 'Could not start sign-in.');
  }

  const { nonce, authUrl } = start.data;
  onStatus?.({ phase: 'waiting', authUrl });
  shell.openExternal(authUrl);

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const poll = await api('GET', `/auth/poll?nonce=${encodeURIComponent(nonce)}`);
    if (poll.data.status === 'ok') {
      return { ...poll.data, ts: Math.floor(Date.now() / 1000) };
    }
    if (poll.data.status === 'expired') {
      throw new Error('Sign-in link expired — try again.');
    }
  }
  throw new Error('Timed out waiting for sign-in.');
}

function isSessionValid(session) {
  return !!(session && session.token && session.sessionExpires && session.sessionExpires > Math.floor(Date.now() / 1000));
}

module.exports = { deviceLogin, isSessionValid, WORKER_URL };
