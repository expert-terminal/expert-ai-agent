(async () => {
  const settings = await window.expertAgent.getSettings();

  const workdirEl = document.getElementById('workdir');
  const autoStartEl = document.getElementById('autoStart');
  const autoRunEl = document.getElementById('autoRun');
  const statusPill = document.getElementById('statusPill');
  const agentStatusPill = document.getElementById('agentStatusPill');
  const signedOutBox = document.getElementById('signedOutBox');
  const signedInBox = document.getElementById('signedInBox');
  const emailEl = document.getElementById('email');
  const authHintEl = document.getElementById('authHint');
  const signedInEmailEl = document.getElementById('signedInEmail');
  const pairingCodeEl = document.getElementById('pairingCode');
  const serverStatusEl = document.getElementById('serverStatus');
  const serverCredsEl = document.getElementById('serverCreds');
  const serverLogEl = document.getElementById('serverLog');

  workdirEl.value = settings.workdir;
  autoStartEl.checked = !!settings.autoStart;
  autoRunEl.checked = !!settings.autoRun;

  // The one thing a non-technical user actually needs to know at a glance: is
  // Agent mode usable right now, and if not, whose problem is it (them signing in,
  // the phone not paired yet, or the server itself broken)? "Paired" here comes
  // from pi-server's OWN pairing state (see getPiServer()'s `paired` field) — not
  // the relay's peer-connected flag, which only reflects the off-WiFi fallback
  // channel and stays unset for the common same-WiFi case, which would otherwise
  // leave this stuck on "Pairing pending" forever even with a phone genuinely
  // connected over LAN.
  let currentSession = null;
  let currentPiServerStatus = 'stopped';
  let currentPiServerPaired = false;

  function refreshAgentStatus() {
    let text = 'Agent ready';
    let cls = 'paired';
    if (!currentSession) {
      text = 'Sign in required';
      cls = '';
    } else if (currentPiServerStatus === 'error') {
      text = 'Agent error';
      cls = 'error';
    } else if (currentPiServerStatus !== 'running') {
      text = 'Starting…';
      cls = '';
    } else if (!currentPiServerPaired) {
      text = 'Pairing pending';
      cls = 'pending';
    }
    agentStatusPill.textContent = text;
    agentStatusPill.className = 'status-pill' + (cls ? ' ' + cls : '');
  }

  function renderSession(session) {
    currentSession = session;
    if (session) {
      signedOutBox.style.display = 'none';
      signedInBox.style.display = '';
      signedInEmailEl.value = session.email;
    } else {
      signedOutBox.style.display = '';
      signedInBox.style.display = 'none';
    }
    refreshAgentStatus();
  }
  renderSession(await window.expertAgent.getSession());

  async function refreshPairing() {
    const pairing = await window.expertAgent.getPairing();
    pairingCodeEl.value = pairing.code || '';
    setStatusPill(pairing.status);
  }
  function setStatusPill(status) {
    // This pill is specifically the off-WiFi relay's own peer-connected state —
    // it does NOT feed the "Agent" pill above, which tracks real pairing
    // (LAN or relay) via pi-server's own state instead.
    statusPill.textContent = status === 'paired' ? 'Relay paired' : status === 'connected' ? 'Relay idle' : status === 'connecting' ? 'Connecting' : 'Offline';
    statusPill.classList.toggle('paired', status === 'paired');
  }
  refreshPairing();
  window.expertAgent.onRelayStatus((status) => setStatusPill(status));

  // pi-server's --qr output prints a terminal glyph-art QR made of half-block
  // Unicode characters, meant for a monospace terminal. Re-rendering that glyph
  // art pixel-perfect in a browser is fragile (font smoothing blurs module edges,
  // and any all-light interior row can silently vanish depending on how it's
  // parsed) and produced QR codes phones sometimes couldn't lock onto. The main
  // process now generates the QR image directly from the real pi://connect URL
  // using a proper QR library (see pi-server:get in main/index.js) and hands the
  // renderer a ready PNG data URL — this is always pixel-exact.
  const qrImg = document.getElementById('qrImg');

  function showQr(qrDataUrl, fallbackText) {
    if (qrDataUrl) {
      qrImg.src = qrDataUrl;
      qrImg.style.display = 'inline-block';
      serverLogEl.style.display = 'none';
    } else {
      qrImg.style.display = 'none';
      serverLogEl.style.display = 'inline-block';
      serverLogEl.textContent = fallbackText || '(waiting for QR — restart the server if this persists)';
    }
  }

  async function refreshPiServer() {
    const s = await window.expertAgent.getPiServer();
    serverStatusEl.textContent = `Status: ${s.status} · port ${s.port}`;
    serverStatusEl.style.color = s.status === 'error' ? '#ff6b6b' : '';
    serverCredsEl.textContent = s.error
      ? `⚠ ${s.error}`
      : s.credentials
        ? `Admin login — username: ${s.credentials.username}, password: ${s.credentials.password}`
        : 'Credentials not generated yet.';
    serverCredsEl.style.color = s.error ? '#ff6b6b' : '';
    if (s.error) {
      qrImg.style.display = 'none';
      serverLogEl.style.display = 'inline-block';
      serverLogEl.textContent = '';
    } else {
      showQr(s.qrDataUrl);
    }
    currentPiServerStatus = s.status;
    currentPiServerPaired = !!s.paired;
    refreshAgentStatus();
  }
  refreshPiServer();
  window.expertAgent.onPiServerStatus(() => refreshPiServer());
  // onPiServerStatus only fires on start/stop/error transitions — pairing and the
  // QR block both change without any status transition (a phone pairing mid-session
  // doesn't stop/restart the process), so without this the pill and QR only ever
  // updated if the user closed and reopened Settings.
  setInterval(refreshPiServer, 5000);

  document.getElementById('restartServer').addEventListener('click', async () => {
    serverStatusEl.textContent = 'Status: restarting…';
    await window.expertAgent.restartPiServer();
    refreshPiServer();
  });

  document.getElementById('rotateCode').addEventListener('click', async () => {
    const result = await window.expertAgent.rotatePairing();
    pairingCodeEl.value = result.code || '';
  });

  document.getElementById('pickFolder').addEventListener('click', async () => {
    workdirEl.value = await window.expertAgent.pickFolder();
    refreshPiServer();
  });

  autoStartEl.addEventListener('change', () => {
    window.expertAgent.setSetting('autoStart', autoStartEl.checked);
  });

  autoRunEl.addEventListener('change', () => {
    window.expertAgent.setSetting('autoRun', autoRunEl.checked);
  });

  document.getElementById('signIn').addEventListener('click', async () => {
    const email = emailEl.value.trim();
    if (!email) return;
    authHintEl.textContent = 'Opening your browser to verify with Ghost…';
    const result = await window.expertAgent.signIn(email);
    if (result.error) {
      authHintEl.textContent = `Error: ${result.error}`;
      return;
    }
    authHintEl.textContent = '';
    renderSession(result.session);
  });

  document.getElementById('signOut').addEventListener('click', async () => {
    await window.expertAgent.signOut();
    renderSession(null);
  });

  // Dependencies checker (read-only, bundled during build)
  async function checkDependencies() {
    const depsListEl = document.getElementById('dependenciesList');
    const depsHintEl = document.getElementById('depsHint');

    try {
      const results = await window.expertAgent.checkDependencies();
      depsListEl.innerHTML = '';
      let allInstalled = true;

      for (const dep of results) {
        const item = document.createElement('div');
        item.className = 'dep-item';
        if (dep.installed) {
          item.innerHTML = `
            <span class="dep-name">${dep.name}</span>
            <span class="dep-version">v${dep.version}</span>
            <span class="dep-status installed">✓ Installed</span>
          `;
        } else {
          allInstalled = false;
          item.innerHTML = `
            <span class="dep-name">${dep.name}</span>
            <span class="dep-status missing">✗ Missing</span>
          `;
        }
        depsListEl.appendChild(item);
      }

      depsHintEl.textContent = allInstalled
        ? 'All dependencies bundled. Agent mode is ready.'
        : 'Some dependencies missing — this app may not work correctly.';
      depsHintEl.style.color = allInstalled ? '#b6f2c8' : '#ff6b6b';
    } catch (err) {
      depsHintEl.textContent = `Error checking dependencies: ${err.message}`;
      depsHintEl.style.color = '#ff6b6b';
    }
  }

  checkDependencies();
})();
