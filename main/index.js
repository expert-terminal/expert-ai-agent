const { app, Tray, Menu, BrowserWindow, ipcMain, dialog, nativeImage } = require('electron');
const path = require('node:path');
const { Store } = require('./store');
const { RelayClient } = require('./relay');
const { deviceLogin, isSessionValid } = require('./auth');
const { PiServerManager, PI_SERVER_PORT } = require('./pi-server');
const QRCode = require('qrcode');

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

const ICON_PATH = path.join(__dirname, '..', 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png');

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
  if (tray) tray.setContextMenu(buildTrayMenu());
}

// Shared by the tray menu (Start/Stop/Generate New QR) and Settings' own
// buttons — same underlying PiServerManager calls either way, so the two
// surfaces can never end up doing something different for the "same" action.
async function startServer() {
  try {
    await piServer?.start(relayClient?.getTunnelUrl(), store?.get('session'));
  } catch (err) {
    console.error('pi-server start failed:', err);
  }
  refreshTray();
}

async function stopServer() {
  await piServer?.stop();
  refreshTray();
}

function createTray() {
  const image = nativeImage.createFromPath(ICON_PATH);
  tray = new Tray(image.resize({ width: 16, height: 16 }));
  tray.setToolTip('Expert AI Agent');
  tray.setContextMenu(buildTrayMenu());
  tray.on('click', () => createSettingsWindow());
}

app.whenReady().then(() => {
  store = new Store();

  // Autostart on login, matching the "install and use" goal — off switch lives in Settings.
  app.setLoginItemSettings({ openAtLogin: store.get('autoStart'), openAsHidden: true });

  createTray();

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
    console.error('pi-server failed to start:', err);
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

ipcMain.handle('pi-server:get', async () => {
  let connectUrl = piServer?.getConnectUrl() ?? null;
  // pi-server bakes the relay tunnel code into the connect URL ONCE, at the moment
  // it starts (via the EXPERT_AI_RELAY_URL env var) — it never sees the code again
  // after that. If the relay code is ever rotated afterward (rotateCode(), or a
  // fresh one generated on a later launch that reused an old printed QR), the URL
  // still encodes the OLD, now-dead relay room: LAN pairing then works fine, but
  // the off-WiFi relay fallback silently fails against a room nobody is listening
  // in — exactly the kind of thing that turns into "stuck on Waiting for approval"
  // once LAN also fails for any reason. Always overwrite the relay param with the
  // relay client's LIVE code right before generating the QR, so the two can never
  // drift apart, regardless of when/why the code changed.
  if (connectUrl && relayClient) {
    try {
      const rewritten = new URL(connectUrl.replace(/^pi:\/\//, 'https://pi.local/'));
      rewritten.searchParams.set('relay', relayClient.getTunnelUrl());
      connectUrl = 'pi://' + rewritten.href.slice('https://pi.local/'.length);
    } catch {
      // Malformed URL (shouldn't happen) — fall through with the original, unpatched one.
    }
  }
  // Generate the pairing QR here, from the exact plain connect URL, instead of
  // asking the renderer to re-parse pi-server's terminal glyph art — that path
  // was fragile (font smoothing blur, and edge cases where interior all-light
  // rows were mis-handled) and produced QR codes phones sometimes couldn't scan.
  // A real QR library encoding the exact URL string is always pixel-correct.
  let qrDataUrl = null;
  if (connectUrl) {
    try {
      qrDataUrl = await QRCode.toDataURL(connectUrl, {
        errorCorrectionLevel: 'M',
        margin: 2,
        scale: 6,
      });
    } catch {
      qrDataUrl = null;
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

ipcMain.handle('dependencies:check', async () => {
  const dependencies = [
    { name: 'pi-coding-agent', pkg: '@earendil-works/pi-coding-agent' },
    { name: 'pi-ai', pkg: '@earendil-works/pi-ai' },
    { name: 'pi-agent-core', pkg: '@earendil-works/pi-agent-core' },
  ];
  const results = [];
  for (const dep of dependencies) {
    try {
      const mod = require(dep.pkg);
      results.push({ name: dep.name, installed: true, version: mod.version || 'unknown' });
    } catch {
      results.push({ name: dep.name, installed: false, version: null });
    }
  }
  return results;
});
