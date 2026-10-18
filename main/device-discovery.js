const crypto = require('node:crypto');
const os = require('node:os');
const { isSessionValid } = require('./auth');

const ENDPOINT = 'https://api.ssv.asia/v1/agent/devices';

function deviceId(store) {
  let id = store.get('deviceId');
  if (!/^[a-f0-9-]{36}$/.test(id || '')) {
    id = crypto.randomUUID();
    store.set('deviceId', id);
  }
  return id;
}

async function publishDevice(store, getConnectUrl) {
  const session = store.get('session');
  if (!isSessionValid(session)) return;
  const connectUrl = await getConnectUrl();
  if (!connectUrl) return;
  const response = await fetch(ENDPOINT, {
    method: 'PUT',
    headers: { authorization: `Bearer ${session.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId: deviceId(store), name: os.hostname().slice(0, 80), connectUrl }),
    signal: AbortSignal.timeout(4000),
  });
  if (!response.ok) throw new Error(`Device discovery registration failed (${response.status})`);
}

async function removeDevice(store, session) {
  if (!isSessionValid(session)) return;
  await fetch(ENDPOINT, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${session.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId: deviceId(store) }),
    signal: AbortSignal.timeout(4000),
  });
}

module.exports = { publishDevice, removeDevice };
