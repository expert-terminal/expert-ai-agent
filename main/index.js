const { app, Tray, Menu, BrowserWindow, ipcMain, dialog, nativeImage, Notification, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { Store } = require('./store');
const { RelayClient } = require('./relay');
const { consumeJobHandoff, continueJobHandoff, deviceLogin, isSessionValid } = require('./auth');
const { PiServerManager, PI_SERVER_PORT, resourcesRoot } = require('./pi-server');
const QRCode = require('qrcode');
const logger = require('./logger');

// Single instance: the tray app is meant to run one persistent copy per machine.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

let tray = null;
let settingsWindow = null;
let store = null;
let relayClient = null;
let relayStatus = 'disconnected'; // 'disconnected' | 'connecting' | 'connected' | 'paired'
let piServer = null;
let piServerStatus = 'stopped'; // 'stopped' | 'starting' | 'running'
// Tracks whether we've already fired the "Connected" notification for the CURRENT
// pairing — reset to false on every server restart (piServer.start() always resets
// its own `paired` flag too), so reconnecting after a restart notifies again, but a
// steady-state connected app doesn't re-notify on every 4s tray refresh tick.
let notifiedPairedThisRun = false;
// Cache for the pairing QR PNG so the 5s Settings poll doesn't re-encode it every
// tick (see pi-server:get). Keyed on the exact connect URL it was built from.
let qrCache = { url: null, dataUrl: null };

const ICON_PATH = path.join(__dirname, '..', 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png');
const ICON_EXT = process.platform === 'win32' ? 'ico' : 'png';
// Color-coded tray icon variants (see assets/*.{ico,png}) so connection state is
// visible at a glance without opening Settings — grey/plain = not running, amber =
// running but no phone paired yet, green = a phone is actively paired, red = error.
const TRAY_ICONS = {
  idle: path.join(__dirname, '..', 'assets', `tray-idle.${ICON_EXT}`),
  waiting: path.join(__dirname, '..', 'assets', `tray-waiting.${ICON_EXT}`),
  connected: path.join(__dirname, '..', 'assets', `tray-connected.${ICON_EXT}`),
  error: path.join(__dirname, '..', 'assets', `tray-error.${ICON_EXT}`),
};

function trayStateFor(status, paired) {
  if (status === 'error') return 'error';
  if (status !== 'running') return 'idle';
  return paired ? 'connected' : 'waiting';
}

function createSettingsWindow() {
  if (settingsWindow) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 820,
    height: 920,
    minWidth: 640,
    minHeight: 600,
    resizable: true,
    title: 'Expert AI Agent',
    icon: ICON_PATH,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  settingsWindow.setMenuBarVisibility(false);
  settingsWindow.loadFile(path.join(__dirname, '..', 'renderer', 'settings.html'));
  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });
}

function buildTrayMenu() {
  const serverLabel = piServerStatus === 'running' ? 'Server: running' : piServerStatus === 'starting' ? 'Server: starting…' : 'Server: stopped';
  const relayLabel =
    relayStatus === 'paired'
      ? 'Relay: paired'
      : relayStatus === 'connected'
        ? 'Relay: idle'
        : relayStatus === 'connecting'
          ? 'Relay: connecting…'
          : 'Relay: offline';
  const serverRunning = piServerStatus === 'running' || piServerStatus === 'starting';
  return Menu.buildFromTemplate([
    { label: `Expert AI Agent`, enabled: false },
    { label: serverLabel, enabled: false },
    { label: `${relayLabel} (used only off-WiFi)`, enabled: false },
    { type: 'separator' },
    { label: 'Open Settings…', click: () => createSettingsWindow() },
    { type: 'separator' },
    serverRunning
      ? { label: 'Stop Server', click: () => stopServer() }
      : { label: 'Start Server', click: () => startServer() },
    // Restarting pi-server re-runs it with --qr, which forces a brand new
    // qr_id/QR every launch (see pi-server.js) — the same mechanism as
    // Settings' "Restart server" button, exposed here for one-click access
    // without opening the Settings window first.
    { label: 'Generate New QR', click: () => startServer(), enabled: serverRunning },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);
}

function refreshTray() {
  if (!tray) return;
  tray.setContextMenu(buildTrayMenu());

  const paired = piServer?.isPaired() ?? false;
  // Once a phone is paired, ongoing tunnel traffic already proves the relay link
  // is alive — let RelayClient relax its self-check cadence to spare CF quota.
  relayClient?.setActive?.(!paired);
  const state = trayStateFor(piServerStatus, paired);
  try {
    tray.setImage(nativeImage.createFromPath(TRAY_ICONS[state]).resize({ width: 16, height: 16 }));
  } catch {
    // Fall back silently to whatever icon is already set — a missing/unreadable
    // variant shouldn't take the whole tray icon down.
  }
  const tooltipByState = {
    idle: 'Expert AI Agent — server stopped',
    waiting: 'Expert AI Agent — waiting for your phone',
    connected: 'Expert AI Agent — connected',
    error: 'Expert AI Agent — error, open Settings',
  };
  tray.setToolTip(tooltipByState[state]);

  // Fire a native "you're connected" notification the moment a phone actually
  // pairs — this is what makes "download, connect, forget" really work: the user
  // gets confirmation without ever needing to open Settings to check.
  if (paired && !notifiedPairedThisRun) {
    notifiedPairedThisRun = true;
    store?.set('lastPairedAt', Date.now());
    if (settingsWindow) settingsWindow.webContents.send('pi-server:paired');
    if (Notification.isSupported()) {
      new Notification({
        title: 'Expert AI Agent',
        body: 'Your phone is connected. Agent mode is ready to use.',
        icon: ICON_PATH,
      }).show();
    }
  } else if (!paired) {
    notifiedPairedThisRun = false;
  }
}

// Shared by the tray menu (Start/Stop/Generate New QR) and Settings' own
// buttons — same underlying PiServerManager calls either way, so the two
// surfaces can never end up doing something different for the "same" action.
async function startServer() {
  try {
    await piServer?.start(relayClient?.getTunnelUrl(), store?.get('session'));
  } catch (err) {
    logger.log('ERROR', 'pi-server start failed:', err?.stack || err?.message || String(err));
  }
  refreshTray();
}

async function stopServer() {
  await piServer?.stop();
  refreshTray();
}

function createTray() {
  const image = nativeImage.createFromPath(TRAY_ICONS.idle);
  tray = new Tray(image.resize({ width: 16, height: 16 }));
  tray.setToolTip('Expert AI Agent — server stopped');
  tray.setContextMenu(buildTrayMenu());
  tray.on('click', () => createSettingsWindow());
}

app.whenReady().then(() => {
  logger.initLogger();
  store = new Store();

  // Autostart on login, matching the "install and use" goal — off switch lives in Settings.
  app.setLoginItemSettings({ openAtLogin: store.get('autoStart'), openAsHidden: true });

  createTray();
  // Pairing (and un-pairing on restart) changes with no status transition of its
  // own — onPiServerStatus only fires on start/stop/error (see pi-server.js) — so
  // the tray icon/tooltip/notification need their own poll, independent of whether
  // Settings is even open, for "connect and forget" to actually show live state.
  setInterval(refreshTray, 4000);

  // macOS keeps the app in the dock by default; a tray-only app shouldn't show there.
  if (process.platform === 'darwin' && app.dock) app.dock.hide();

  relayClient = new RelayClient({
    store,
    onStatusChange: (status) => {
      relayStatus = status;
      refreshTray();
      if (settingsWindow) settingsWindow.webContents.send('relay:status', status);
    },
  });
  relayClient.start();

  piServer = new PiServerManager({
    store,
    onStatusChange: (status) => {
      piServerStatus = status;
      refreshTray();
      if (settingsWindow) settingsWindow.webContents.send('pi-server:status', status);
      if (status === 'error') logger.log('ERROR', 'pi-server entered error state:', piServer?.getLastError());
    },
  });
  // The real Pico backend, running locally — this is the whole point of Expert AI
  // Agent: pair + keep this running, nothing more. Started once at launch; the
  // relay's tunnel URL is baked into pi-server's QR generation via an env var, so
  // remote (non-LAN) pairing works from the very first QR it prints. Passing the
  // already-signed-in session (if any) here is what pre-wires the gateway model
  // config on a cold launch, not just after the user opens Settings.
  piServer.start(relayClient.getTunnelUrl(), store.get('session')).catch((err) => {
    piServerStatus = 'stopped';
    logger.log('ERROR', 'pi-server failed to start:', err?.stack || err?.message || String(err));
    refreshTray();
  });
});

app.on('before-quit', () => {
  piServer?.shutdown();
});

app.on('second-instance', () => {
  createSettingsWindow();
});

// Tray apps don't quit when their only window closes.
app.on('window-all-closed', (e) => e.preventDefault());

// ---- IPC bridge for the settings window ----

ipcMain.handle('settings:get', () => store.all());

ipcMain.handle('settings:set', (_event, key, value) => {
  store.set(key, value);
  if (key === 'autoStart') {
    app.setLoginItemSettings({ openAtLogin: value, openAsHidden: true });
  }
  return store.all();
});

ipcMain.handle('settings:pickFolder', async () => {
  const result = await dialog.showOpenDialog(settingsWindow, {
    properties: ['openDirectory'],
    defaultPath: store.get('workdir'),
  });
  if (result.canceled || result.filePaths.length === 0) return store.get('workdir');
  store.set('workdir', result.filePaths[0]);
  // pi-server reads its working folder from config.toml at startup — regenerate and
  // restart so a folder change actually takes effect, not just on next app launch.
  piServer?.start(relayClient.getTunnelUrl()).catch((err) => console.error('pi-server restart failed:', err));
  return result.filePaths[0];
});

ipcMain.handle('pairing:get', () => ({ code: relayClient?.getCode(), status: relayStatus }));

ipcMain.handle('pairing:rotate', () => {
  const code = relayClient?.rotateCode();
  return { code, status: relayStatus };
});

ipcMain.handle('auth:getSession', () => {
  const session = store.get('session');
  return isSessionValid(session) ? session : null;
});

ipcMain.handle('auth:signIn', async (_event, email) => {
  try {
    const session = await deviceLogin(email);
    store.set('session', session);
    // The gateway model config Agent mode needs (~/.pi/agent/models.json) is
    // keyed on this session's token — regenerate + restart immediately so the
    // user never has to manually restart the server after signing in.
    piServer?.start(relayClient?.getTunnelUrl(), session).catch((err) =>
      console.error('pi-server restart after sign-in failed:', err),
    );
    return { session };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
});

ipcMain.handle('auth:signOut', () => {
  store.set('session', null);
  piServer?.start(relayClient?.getTunnelUrl(), null).catch((err) =>
    console.error('pi-server restart after sign-out failed:', err),
  );
  return { ok: true };
});

ipcMain.handle('handoff:consume', async (_event, jobId, invitationToken) => {
  try {
    const result = await consumeJobHandoff(store.get('session'), jobId, invitationToken);
    return { ok: true, ...result };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle('handoff:continue', async (_event, jobId, state, sessionId, instruction) => {
  try { return { ok: true, result: await continueJobHandoff(store.get('session'), jobId, state, sessionId, instruction) }; }
  catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
});

ipcMain.handle('pi-server:get', async () => {
  let connectUrl = piServer?.getConnectUrl() ?? null;
  const relayReady = relayClient?.isReady?.() ?? false;
  let lanCount = 0;
  // ── Relay-primary QR ─────────────────────────────────────────────────────────
  // The released APK (parse-connect-url.ts / qr-scanner doPair) treats `relay` as
  // the guaranteed pairing path: it walks any `ips` first, then falls straight
  // through to the relay tunnel. Remote Pi "connects every time" because its QR
  // carries a single fixed relay address and nothing network-topology-specific;
  // this makes ours behave the same while KEEPING the LAN fast-path when it's
  // genuinely available.
  //
  // Two failure modes this block exists to kill:
  //  1. Stale relay code. pi-server bakes EXPERT_AI_RELAY_URL into the printed URL
  //     once at spawn; if the relay code rotated/reconnected since, that room is
  //     dead. We always overwrite `relay` with relayClient.getTunnelUrl()'s LIVE
  //     code right before drawing the QR, so QR and registered socket can't drift.
  //  2. The interface-walk hang. pi-server's connection.rs enumerates every
  //     adapter (fe80:: link-local, 169.254.x APIPA, global IPv6, 172.x WSL/Docker
  //     NAT, the 192.168.137.x hotspot bridge). The phone walks them one at a time
  //     at ~4s each; a slow real-LAN response loses the race and the one-time
  //     qr_id gets burned mid-walk -> permanent "waiting for approval". Fix: keep
  //     at most ONE real router-LAN IPv4 and at most one hotspot IPv4 — both truly
  //     reachable, so no dead entry ever costs a 4s timeout — and let the relay be
  //     the fallback for everything else. Do NOT include "localhost": the released
  //     app's resolveBaseUrl() literally prefers an `ips` entry equal to
  //     "localhost", which a phone can never reach.
  if (connectUrl) {
    try {
      const rewritten = new URL(connectUrl.replace(/^pi:\/\//, 'https://pi.local/'));
      const rawIps = (rewritten.searchParams.get('ips') ?? '')
        .split(',').map((s) => s.trim()).filter(Boolean);
      const isPrivateV4 = (ip) =>
        /^192\.168\./.test(ip) || /^10\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
      const isDockerNat = (ip) => /^172\./.test(ip);          // WSL/Hyper-V/Docker NAT — unreachable from a phone
      const isHotspot = (ip) => /^192\.168\.137\./.test(ip);  // Windows Mobile Hotspot gateway
      const routerLan = rawIps.filter((ip) => isPrivateV4(ip) && !isDockerNat(ip) && !isHotspot(ip));
      const hotspot = rawIps.filter(isHotspot);
      const lanFallback = routerLan.length ? routerLan.slice(0, 1) : hotspot.slice(0, 1);
      const tunnelUrl = relayClient?.getTunnelUrl?.() ?? null;

      // THE key decision. The released APK has TWO scan paths and one of them —
      // the OS deep-link handler (app/connect.tsx) — picks ips[0], has NO relay
      // fallback, and NO timeout. So any LAN IP in the QR that the phone can't
      // actually reach (AP isolation, client isolation, a different subnet/VLAN,
      // a firewall) = permanent "Waiting for approval" with no recovery.
      //
      // Therefore: once the relay tunnel is CONFIRMED round-tripping
      // (relayClient.isReady() = socket open AND a real /tunnel/<code> health
      // probe came back — see relay.js _verifyRegistration), ship a RELAY-ONLY QR
      // with no `ips` at all. Both released paths then go straight to the relay:
      //   - connect.tsx:  !preferredHost && params.relay  -> returns params.relay
      //   - qr-scanner:   ips.length 0 -> tryLanSerial([]) no-ops -> relay branch
      // Same-Wi-Fi phones pair through the relay too (~1s, measured). Losing the
      // LAN fast-path is the price of "connects every time" — same design as the
      // reference app that does work reliably.
      //
      // Only when the relay is NOT confirmed do we fall back to a single real
      // LAN IP, so same-network pairing still works while the relay (re)registers.
      let ipsForQr;
      if (relayReady && tunnelUrl) {
        ipsForQr = [];
      } else {
        ipsForQr = lanFallback;
      }
      lanCount = ipsForQr.length;

      rewritten.searchParams.set('ips', ipsForQr.join(','));
      rewritten.searchParams.delete('hostname');
      if (tunnelUrl) {
        rewritten.searchParams.set('relay', tunnelUrl);
      } else {
        rewritten.searchParams.delete('relay');
      }
      connectUrl = 'pi://' + rewritten.href.slice('https://pi.local/'.length);
      console.log(`[pi-server] pairing QR — mode: ${relayReady && tunnelUrl ? 'RELAY-ONLY' : 'lan+relay'}, ips: [${ipsForQr.join(',') || 'none'}], relay: ${tunnelUrl ? 'live' : 'none'}, relayReady: ${relayReady}`);
    } catch {
      // Malformed URL (shouldn't happen) — fall through with the original, unpatched one.
    }
  }

  // Never present a QR that has no working way in: if the relay socket isn't
  // actually open AND there's no reachable LAN address in the payload, the phone
  // would scan it, fail every path, and sit on "waiting for approval". Suppress it
  // and let Settings show the "connecting…" state until the relay is up.
  if (connectUrl && !relayReady && lanCount === 0) {
    console.log('[pi-server] suppressing pairing QR — relay not ready and no LAN address');
    connectUrl = null;
  }
  // Generate the pairing QR here, from the exact plain connect URL, instead of
  // asking the renderer to re-parse pi-server's terminal glyph art — that path
  // was fragile (font smoothing blur, and edge cases where interior all-light
  // rows were mis-handled) and produced QR codes phones sometimes couldn't scan.
  // A real QR library encoding the exact URL string is always pixel-correct.
  // Settings polls this handler every 5s. Re-encoding the QR each time is pure CPU
  // burn on the main process — and the main process is exactly what has to shuttle
  // pi-server's stdout to our auto-"y" on its stdin during pairing, a round-trip the
  // phone only waits ~4s for. Cache the PNG and only regenerate when the underlying
  // connect URL actually changes (a restart / new qr_id).
  let qrDataUrl = null;
  if (connectUrl) {
    if (qrCache.url === connectUrl && qrCache.dataUrl) {
      qrDataUrl = qrCache.dataUrl;
    } else {
      try {
        qrDataUrl = await QRCode.toDataURL(connectUrl, {
          errorCorrectionLevel: 'M',
          margin: 2,
          scale: 6,
        });
      } catch {
        qrDataUrl = null;
      }
      qrCache = { url: connectUrl, dataUrl: qrDataUrl };
    }
  }
  return {
    status: piServerStatus,
    port: PI_SERVER_PORT,
    credentials: piServer?.getCredentials(),
    log: piServer?.getLog(),
    connectUrl,
    qrDataUrl,
    error: piServer?.getLastError(),
    paired: piServer?.isPaired() ?? false,
    relayStatus,
    relayReady,
    // True when the QR was withheld because no path (relay or LAN) is live yet —
    // lets Settings show "connecting…" instead of a blank/again-failing QR.
    pairingPending: !connectUrl && (piServerStatus === 'running' || piServerStatus === 'starting'),
  };
});

ipcMain.handle('pi-server:restart', async () => {
  await startServer();
  return { status: piServerStatus };
});

ipcMain.handle('pi-server:stop', async () => {
  await stopServer();
  return { status: piServerStatus };
});

ipcMain.handle('shell:openExternal', (_event, url) => {
  // Only ever open http(s) links a Settings click triggers — never anything
  // renderer-supplied that isn't a plain web URL.
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) shell.openExternal(url);
});

// One-click "what's wrong" bundle for support requests — a non-technical user
// can't attach a stack trace, but they can click a button and paste the result.
ipcMain.handle('diagnostics:get', async () => {
  return {
    version: app.getVersion(),
    platform: process.platform,
    piServerStatus,
    relayStatus,
    lastError: piServer?.getLastError() ?? null,
    paired: piServer?.isPaired() ?? false,
    logTail: logger.readLogTail(8000),
  };
});

ipcMain.handle('dependencies:check', async () => {
  // This previously checked the ELECTRON APP's OWN node_modules (path.join(__dirname,
  // '..', 'node_modules')) — a copy of these same package names that has ZERO bearing
  // on whether Agent mode actually runs. The real runtime pi.cmd spawns lives in
  // resourcesRoot() (resources/pi-node, cross-platform via pi-server.js's own
  // process.resourcesPath resolution — works identically packaged or in dev, on
  // Windows or macOS). Checking the wrong location is exactly what let the
  // node.exe/pi-coding-agent bundling bug go unnoticed: this panel would have shown
  // "✓ All dependencies bundled, Agent mode is ready" the entire time it was broken.
  //
  // Only pi-coding-agent itself is checked here — pi-agent-core/pi-ai are bundled
  // directly INTO pi-coding-agent's own published dist/cli.js at build time (verified:
  // they don't exist anywhere in the installed tree, nested or otherwise, yet the CLI
  // runs correctly), so they were never real standalone runtime requirements. Listing
  // them here just produced a permanent, meaningless "missing" false alarm.
  const dependencies = [
    { name: 'pi-coding-agent', pkg: '@earendil-works/pi-coding-agent' },
  ];
  const results = [];
  const piNodeRoot = resourcesRoot();
  const nodeModulesPath = path.join(piNodeRoot, 'node_modules');

  for (const dep of dependencies) {
    const pkgPath = path.join(nodeModulesPath, dep.pkg, 'package.json');
    try {
      if (fs.existsSync(pkgPath)) {
        const pkgJson = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        results.push({ name: dep.name, installed: true, version: pkgJson.version || 'unknown' });
      } else {
        results.push({ name: dep.name, installed: false, version: null });
      }
    } catch {
      results.push({ name: dep.name, installed: false, version: null });
    }
  }

  // The two other things that must ALSO be real for Agent mode to actually start —
  // checking package presence alone isn't sufficient, as today's bug proved.
  const isWin = process.platform === 'win32';
  const nodeBinName = isWin ? 'node.exe' : 'node';
  const nodeBinPath = path.join(piNodeRoot, nodeBinName);
  results.push({ name: 'node runtime', installed: fs.existsSync(nodeBinPath), version: fs.existsSync(nodeBinPath) ? 'bundled' : null });

  const serverBinName = isWin ? 'pi-server.exe' : 'pi-server';
  const serverBinPackaged = path.join(process.resourcesPath, serverBinName);
  const serverBinDev = path.resolve(__dirname, '..', 'resources', serverBinName);
  const serverBinPath = fs.existsSync(serverBinPackaged) ? serverBinPackaged : serverBinDev;
  results.push({ name: 'pi-server', installed: fs.existsSync(serverBinPath), version: fs.existsSync(serverBinPath) ? 'bundled' : null });

  return results;
});
