// Same gateway the phone app and this tray app's own auth.js already talk to —
// used here only to read usage/plan info for display, same GET /balance the
// phone app's account sheet uses. No APK/worker change involved.
const GATEWAY_URL = 'https://api.ssv.asia'; // custom domain (verified 2026-08-29); was expert-ai-gateway.arthouse.workers.dev

function formatTokenCount(n) {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

// Mirrors the phone app's own freeModelDescription logic exactly (lib/gateway-client.ts
// usage in app/simple-chat.tsx) — same wording, same fields — so a user sees a
// consistent story about their plan whether they're looking at their phone or this
// tray app's Settings window.
function formatUsageText(balance) {
  if (!balance) return '';
  if (!balance.passActive) {
    const c = balance.community;
    return c ? `Free tier, ${c.used}/${c.limit} messages today` : 'Free tier, limited messages/day';
  }
  const used = (balance.used?.pro || 0) + (balance.used?.foundation || 0) + (balance.used?.free || 0) + (balance.used?.opus || 0);
  const label = balance.tierLabel || 'Unlimited AI';
  if (used > 0) return `${label} — included in your plan, ${formatTokenCount(used)} tokens used`;
  return `${label} — included in your plan`;
}

(async () => {
  const settings = await window.expertAgent.getSettings();

  // ---- Element refs ----
  const workdirEl = document.getElementById('workdir');
  const autoStartEl = document.getElementById('autoStart');
  const autoRunEl = document.getElementById('autoRun');
  const signedOutBox = document.getElementById('signedOutBox');
  const signedInBox = document.getElementById('signedInBox');
  const emailEl = document.getElementById('email');
  const authHintEl = document.getElementById('authHint');
  const signedInEmailEl = document.getElementById('signedInEmail');
  const pairingCodeEl = document.getElementById('pairingCode');
  const serverStatusEl = document.getElementById('serverStatus');
  const serverCredsEl = document.getElementById('serverCreds');
  const serverLogEl = document.getElementById('serverLog');
  const qrImg = document.getElementById('qrImg');
  const qrWrap = document.getElementById('qrWrap');
  const statusDot = document.getElementById('statusDot');
  const heroTitle = document.getElementById('heroTitle');
  const heroSub = document.getElementById('heroSub');
  const heroError = document.getElementById('heroError');
  const generateQrBtn = document.getElementById('generateQr');
  const dashboard = document.getElementById('dashboard');
  const wizard = document.getElementById('wizard');
  const wizStep1 = document.getElementById('wizStep1');
  const wizStep2 = document.getElementById('wizStep2');
  const wizSignInBox = document.getElementById('wizSignIn');
  const wizPairBox = document.getElementById('wizPair');
  const wizEmailEl = document.getElementById('wizEmail');
  const wizAuthHintEl = document.getElementById('wizAuthHint');
  const wizQrImg = document.getElementById('wizQrImg');
  const usageInfoEl = document.getElementById('usageInfo');

  workdirEl.value = settings.workdir;
  autoStartEl.checked = !!settings.autoStart;
  autoRunEl.checked = !!settings.autoRun;

  let currentSession = null;
  let currentPiServerStatus = 'stopped';
  let currentPiServerPaired = false;
  let setupDone = !!settings.hasCompletedSetup;
  let lastPairedAt = settings.lastPairedAt || null;

  // ---- First-run wizard vs. compact dashboard ----
  function showWizard() {
    wizard.style.display = '';
    dashboard.style.display = 'none';
  }
  function showDashboard() {
    wizard.style.display = 'none';
    dashboard.style.display = '';
  }
  async function completeSetup() {
    if (setupDone) return;
    setupDone = true;
    await window.expertAgent.setSetting('hasCompletedSetup', true);
    showDashboard();
  }
  function refreshWizardStep() {
    if (setupDone) return;
    const signedIn = !!currentSession;
    wizStep1.classList.toggle('done', signedIn);
    wizStep2.classList.toggle('done', signedIn && currentPiServerPaired);
    wizSignInBox.style.display = signedIn ? 'none' : '';
    wizPairBox.style.display = signedIn ? '' : 'none';
    if (signedIn && currentPiServerPaired) completeSetup();
  }
  document.getElementById('wizSkip').addEventListener('click', completeSetup);
  document.getElementById('wizSignInBtn').addEventListener('click', async () => {
    const email = wizEmailEl.value.trim();
    if (!email) return;
    wizAuthHintEl.textContent = 'Opening your browser to verify with Ghost…';
    const result = await window.expertAgent.signIn(email);
    if (result.error) {
      wizAuthHintEl.textContent = `Error: ${result.error}`;
      return;
    }
    wizAuthHintEl.textContent = '';
    renderSession(result.session);
  });

  if (setupDone) showDashboard(); else showWizard();

  // ---- Hero connection state ----
  function refreshHero() {
    let dotClass = '';
    let title = 'Checking…';
    let sub = '';
    let errorText = '';
    let showQr = false;

    if (!currentSession) {
      title = 'Sign in required';
      sub = 'Sign in below to start the agent.';
    } else if (currentPiServerStatus === 'error') {
      dotClass = 'error';
      title = 'Something went wrong';
      sub = 'See the details below, or try restarting the server.';
      errorText = serverCredsEl.dataset.error || '';
    } else if (currentPiServerStatus !== 'running') {
      title = 'Starting…';
      sub = 'The local agent server is starting up.';
    } else if (!currentPiServerPaired) {
      dotClass = 'waiting';
      title = 'Waiting for your phone';
      sub = 'Scan the QR below in Expert AI Chat → Agent mode.';
      showQr = true;
      generateQrBtn.textContent = 'Generate New QR';
    } else {
      dotClass = 'connected';
      title = 'Connected';
      sub = lastPairedAt
        ? `Ready to use — connected at ${new Date(lastPairedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
        : 'Agent mode is ready to use on your phone.';
      generateQrBtn.textContent = 'Pair Another Device';
    }

    statusDot.className = 'status-dot' + (dotClass ? ' ' + dotClass : '');
    heroTitle.textContent = title;
    heroSub.textContent = sub;
    heroError.style.display = errorText ? '' : 'none';
    heroError.textContent = errorText;
    qrWrap.classList.toggle('visible', showQr);

    refreshWizardStep();
  }

  async function refreshUsage() {
    if (!currentSession?.token) return;
    try {
      const res = await fetch(`${GATEWAY_URL}/balance`, {
        headers: { Authorization: `Bearer ${currentSession.token}` },
      });
      const balance = await res.json();
      if (!res.ok) throw new Error(balance?.error || 'Could not load usage');
      usageInfoEl.textContent = formatUsageText(balance);
    } catch {
      usageInfoEl.textContent = 'Agent mode runs under this account — same plan/quota as Chat mode on your phone.';
    }
  }

  function renderSession(session) {
    currentSession = session;
    if (session) {
      signedOutBox.style.display = 'none';
      signedInBox.style.display = '';
      signedInEmailEl.value = session.email;
      usageInfoEl.textContent = 'Loading usage…';
      refreshUsage();
    } else {
      signedOutBox.style.display = '';
      signedInBox.style.display = 'none';
    }
    refreshHero();
  }
  renderSession(await window.expertAgent.getSession());
  setInterval(refreshUsage, 60000);

  async function refreshPairing() {
    const pairing = await window.expertAgent.getPairing();
    pairingCodeEl.value = pairing.code || '';
  }
  refreshPairing();

  async function refreshPiServer() {
    const s = await window.expertAgent.getPiServer();
    serverStatusEl.textContent = `Status: ${s.status} · port ${s.port}`;
    serverStatusEl.style.color = s.status === 'error' ? '#e74c3c' : '';
    serverCredsEl.textContent = s.error
      ? `⚠ ${s.error}`
      : s.credentials
        ? `Admin login — username: ${s.credentials.username}, password: ${s.credentials.password}`
        : 'Credentials not generated yet.';
    serverCredsEl.dataset.error = s.error || '';
    serverCredsEl.style.color = s.error ? '#e74c3c' : '';

    if (s.qrDataUrl) {
      qrImg.src = s.qrDataUrl;
      qrImg.style.display = 'inline-block';
      wizQrImg.src = s.qrDataUrl;
      serverLogEl.style.display = 'none';
    } else {
      qrImg.style.display = 'none';
      serverLogEl.style.display = 'inline-block';
      serverLogEl.textContent = '(waiting for QR — try Generate New QR below if this persists)';
    }

    currentPiServerStatus = s.status;
    currentPiServerPaired = !!s.paired;
    refreshHero();
  }
  refreshPiServer();
  window.expertAgent.onPiServerStatus(() => refreshPiServer());
  window.expertAgent.onPaired(async () => {
    const fresh = await window.expertAgent.getSettings();
    lastPairedAt = fresh.lastPairedAt || lastPairedAt;
    refreshPiServer();
  });
  // Pairing can change with no status transition of its own (a phone pairing
  // mid-session doesn't stop/restart the server) — poll so the hero/QR stay live
  // even if neither onPiServerStatus nor onPaired happens to fire.
  setInterval(refreshPiServer, 5000);

  document.getElementById('generateQr').addEventListener('click', async () => {
    heroTitle.textContent = 'Restarting…';
    await window.expertAgent.restartPiServer();
    refreshPiServer();
  });
  document.getElementById('restartServer').addEventListener('click', async () => {
    heroTitle.textContent = 'Restarting…';
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

  document.getElementById('consumeHandoff').addEventListener('click', async () => {
    const status = document.getElementById('handoffStatus');
    const jobId = document.getElementById('handoffJobId').value.trim();
    const token = document.getElementById('handoffToken').value.trim();
    if (!jobId || !token) {
      status.textContent = 'Enter both the mobile job ID and invitation.';
      return;
    }
    status.textContent = 'Validating invitation…';
    const result = await window.expertAgent.consumeJobHandoff(jobId, token);
    if (!result.ok) {
      status.textContent = `Handoff unavailable: ${result.error}`;
      return;
    }
    const state = result.state || {};
    status.textContent = `Imported ${state.status || 'unknown'} job · ${state.text ? `${state.text.length} response characters available` : 'no response text yet'}. Local-agent continuation is not enabled yet.`;
    document.getElementById('handoffToken').value = '';
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
      depsHintEl.style.color = allInstalled ? '#2ecc71' : '#e74c3c';
    } catch (err) {
      depsHintEl.textContent = `Error checking dependencies: ${err.message}`;
      depsHintEl.style.color = '#e74c3c';
    }
  }

  checkDependencies();

  document.getElementById('helpLink').addEventListener('click', (e) => {
    e.preventDefault();
    window.expertAgent.openExternal('https://ssv.asia/android-help-center/');
  });
  document.getElementById('contactSupportLink').addEventListener('click', (e) => {
    e.preventDefault();
    const text = encodeURIComponent(
      `Hi, I need help with Expert AI Agent (${currentSession?.email ?? 'not signed in'}).`,
    );
    window.expertAgent.openExternal(`https://wa.me/919914499477?text=${text}`);
  });

  document.getElementById('copyDiagnostics').addEventListener('click', async () => {
    const diagnosticsHint = document.getElementById('diagnosticsHint');
    try {
      const d = await window.expertAgent.getDiagnostics();
      const report = [
        `Expert AI Agent v${d.version} (${d.platform})`,
        `Server: ${d.piServerStatus} · Relay: ${d.relayStatus} · Paired: ${d.paired}`,
        d.lastError ? `Last error: ${d.lastError}` : null,
        '--- recent log ---',
        d.logTail || '(empty)',
      ].filter(Boolean).join('\n');
      await navigator.clipboard.writeText(report);
      diagnosticsHint.textContent = 'Copied — paste it wherever you need to share it.';
    } catch (err) {
      diagnosticsHint.textContent = `Could not copy: ${err.message}`;
    }
  });
})();
