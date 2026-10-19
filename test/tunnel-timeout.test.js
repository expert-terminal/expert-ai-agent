'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { tunnelFetchTimeoutMs } = require('../main/tunnel-timeout');

test('Windows Pi session lifecycle gets enough time for cold startup', () => {
  assert.equal(tunnelFetchTimeoutMs('/api/agent/sessions', 'win32'), 35000);
  assert.equal(tunnelFetchTimeoutMs('/api/agent/sessions/sess-1/touch', 'win32'), 35000);
  assert.equal(tunnelFetchTimeoutMs('/api/agent/new-session?source=mobile', 'win32'), 35000);
  assert.equal(tunnelFetchTimeoutMs('/api/agent/switch-session', 'win32'), 35000);
});

test('pairing, ordinary requests, and non-Windows behavior keep the short timeout', () => {
  assert.equal(tunnelFetchTimeoutMs('/api/auth/pair', 'win32'), 10000);
  assert.equal(tunnelFetchTimeoutMs('/api/agent/prompt', 'win32'), 10000);
  assert.equal(tunnelFetchTimeoutMs('/api/agent/sessions', 'darwin'), 10000);
  assert.equal(tunnelFetchTimeoutMs('/api/agent/sessions', 'linux'), 10000);
});
