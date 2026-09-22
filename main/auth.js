// Device-login flow, ported from the real shipped CLI (expert-ai@0.6.2's bin/x.js) —
// same gateway, same /auth/start + /auth/poll calls, same session shape. This is what
// gives the tray app its OWN signed-in gateway session, so Agent mode bills against
// the same account/entitlement as Chat mode on the phone, no separate credential path.
const { shell } = require('electron');

// Custom domain first (verified 2026-08-29), workers.dev only as a fallback.
// Indian ISP resolvers (Jio/Airtel/ACT) commonly NXDOMAIN Cloudflare's shared
// *.workers.dev ranges, which used to make sign-in on a hostile Wi-Fi fail hard —
// api.ssv.asia is a dedicated zone those blocklists don't touch.
const WORKER_HOSTS = [
  'https://api.ssv.asia',
  'https://expert-ai-gateway.arthouse.workers.dev',
];
const WORKER_URL = WORKER_HOSTS[0];
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;

async function api(method, path, body, extraHeaders = {}) {
  let lastErr;
  for (const host of WORKER_HOSTS) {
    try {
      const r = await fetch(`${host}${path}`, {
        method,
        headers: { 'content-type': 'application/json', ...extraHeaders },
        body: body ? JSON.stringify(body) : undefined,
      });
      let data = {};
      try { data = await r.json(); } catch { /* non-JSON error body */ }
      return { ok: r.ok, status: r.status, data };
    } catch (err) {
      lastErr = err; // network/DNS failure — try the next host
    }
  }
  throw lastErr || new Error('Network request failed');
}

async function localApi(method, path, body, extraHeaders = {}) {
  const r = await fetch(`http://127.0.0.1:5454${path}`, { method, headers: { 'content-type': 'application/json', ...extraHeaders }, body: body ? JSON.stringify(body) : undefined });
  let data = {};
  try { data = await r.json(); } catch { /* non-JSON error body */ }
  return { ok: r.ok, status: r.status, data };
}

async function consumeJobHandoff(session, jobId, invitationToken) {
  if (!isSessionValid(session)) throw new Error('Sign in to the same Expert AI account first.');
  const handoff = await api('POST', '/v1/chat/jobs/handoff/consume', { jobId, token: invitationToken }, { Authorization: `Bearer ${session.token}` });
  if (!handoff.ok) throw new Error(handoff.data?.error?.message || handoff.data?.error || 'Could not consume the handoff invitation.');
  const state = await api('GET', `/v1/chat/jobs?jobId=${encodeURIComponent(jobId)}`, undefined, { Authorization: `Bearer ${session.token}` });
  if (!state.ok) throw new Error('Handoff accepted, but the durable job state could not be loaded.');
  return { handoff: handoff.data, state: state.data };
}

async function continueJobHandoff(session, jobId, state, sessionId, instruction) {
  if (!isSessionValid(session)) throw new Error('Sign in to the same Expert AI account first.');
  if (!sessionId || !instruction) throw new Error('A local agent session and continuation instruction are required.');
  const message = [`Continue imported durable job ${jobId}.`, 'Prior gateway result:', state?.text || '(no completed response yet)', 'Continuation instruction:', instruction].join('\n\n');
  const result = await localApi('POST', '/api/agent/prompt', { session_id: sessionId, message, streaming_behavior: 'steer' }, { Authorization: `Bearer ${session.token}` });
  if (!result.ok) throw new Error(result.data?.error?.message || result.data?.error || 'Local agent rejected the continuation.');
  return result.data;
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

module.exports = { consumeJobHandoff, continueJobHandoff, deviceLogin, isSessionValid, WORKER_URL };
