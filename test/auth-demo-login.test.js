'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const openedExternal = [];
const originalLoad = Module._load;
Module._load = function loadWithElectronShellStub(request, parent, isMain) {
  if (request === 'electron') {
    return { shell: { openExternal: (url) => openedExternal.push(url) } };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const { deviceLogin } = require('../main/auth');
Module._load = originalLoad;

async function withLoginMocks(startData, run) {
  const originalFetch = global.fetch;
  const originalSetTimeout = global.setTimeout;
  const requests = [];
  let delayCount = 0;

  global.fetch = async (url, options) => {
    requests.push({ url, method: options.method });
    const body = options.method === 'POST' ? startData : {
      status: 'ok',
      email: 'demo@ssv.asia',
      token: 'signed-demo-session',
      sessionExpires: Math.floor(Date.now() / 1000) + 3600,
    };
    return { ok: true, status: 200, json: async () => body };
  };
  global.setTimeout = (callback) => {
    delayCount += 1;
    queueMicrotask(callback);
    return 1;
  };

  try {
    openedExternal.length = 0;
    await run({ requests, get delayCount() { return delayCount; } });
  } finally {
    global.fetch = originalFetch;
    global.setTimeout = originalSetTimeout;
  }
}

test('server-confirmed demo login skips the browser and polls immediately', async () => {
  await withLoginMocks({ nonce: 'demo-nonce', authUrl: 'https://ssv.asia/connect/', demo: true }, async (state) => {
    const session = await deviceLogin(' DEMO@SSV.ASIA ');
    assert.equal(session.token, 'signed-demo-session');
    assert.deepEqual(openedExternal, []);
    assert.equal(state.requests.length, 2);
    assert.equal(state.requests[1].method, 'GET');
    assert.equal(state.delayCount, 0);
  });
});

test('demo email without the gateway demo flag still uses normal verification', async () => {
  await withLoginMocks({ nonce: 'ordinary-nonce', authUrl: 'https://ssv.asia/connect/' }, async (state) => {
    const session = await deviceLogin('demo@ssv.asia');
    assert.equal(session.token, 'signed-demo-session');
    assert.deepEqual(openedExternal, ['https://ssv.asia/connect/']);
    assert.equal(state.delayCount, 1);
  });
});
