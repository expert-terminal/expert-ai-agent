'use strict';

const DEFAULT_TUNNEL_FETCH_TIMEOUT_MS = 10000;
const PI_SESSION_START_TIMEOUT_MS = 35000;

// Rust allows 30 seconds for Pi RPC startup. Give Store builds enough time for
// cold starts/resumes instead of aborting at the relay's ordinary 10-second cap.
// This affects only the Windows session lifecycle calls; other requests and
// platforms retain the established timeout.
function tunnelFetchTimeoutMs(requestPath, platform = process.platform) {
  if (platform !== 'win32') return DEFAULT_TUNNEL_FETCH_TIMEOUT_MS;

  const pathname = String(requestPath || '').split('?', 1)[0];
  if (
    pathname === '/api/agent/sessions' ||
    /^\/api\/agent\/sessions\/[^/]+\/touch$/.test(pathname) ||
    pathname === '/api/agent/new-session' ||
    pathname === '/api/agent/switch-session'
  ) {
    return PI_SESSION_START_TIMEOUT_MS;
  }

  return DEFAULT_TUNNEL_FETCH_TIMEOUT_MS;
}

module.exports = { tunnelFetchTimeoutMs };
