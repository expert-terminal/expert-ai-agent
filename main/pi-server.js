// Spawns and manages the REAL pi-server binary (backend/, compiled from
// pico-upstream — this IS the Pico mobile app's actual backend, same generated
// API client the app already speaks). Expert AI Agent's job is exactly what the
// user asked: a settings dashboard that pairs and keeps this running — not its
// own agent implementation. That's what pi-server itself does, managing the real
// `pi` coding-agent underneath (see backend/src/config/mod.rs's [package] setting).
const { spawn, spawnSync } = require('node:child_process');
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const net = require('node:net');

const PI_SERVER_PORT = 5454;

// The whole point of a white-labeled tray app: nobody who installs it should ever
// need Node.js, npm, or a hand-configured API key already on their machine. A full
// portable Node + the real @earendil-works/pi-coding-agent package (already
// installed, no npm-install-on-first-run step) ships inside resources/pi-node/, and
// pi-server.js points pi-server's own [paths] config directly at it — so
// `get_agent_runtime_status` (backend/src/services/runtime.rs) sees both node and pi
// as "installed" from the very first launch, on a completely clean machine.
/** The pi engine (portable Node + @earendil-works/pi-coding-agent) this app runs.
 *  Resolution order:
 *    1. <userData>/pi-node  — a user-updated copy (see pi-engine:update IPC). This
 *       is how "Expert AI Agent always runs the latest pi" works WITHOUT touching
 *       the other pi-based products on the machine (Expert AI Terminal / Pro /
 *       Expert OS) — they use their own global install; this dir is ours alone.
 *    2. the packaged/bundled resources/pi-node — the always-present, known-good
 *       fallback. Deleting the userData copy cleanly reverts to this.
 *  Isolation is further guaranteed by pointing HOME/USERPROFILE at userData when
 *  spawning pi-server, so ~/.pi never collides with the CLI's. */
function bundledResourcesRoot() {
  const packaged = path.join(process.resourcesPath, 'pi-node');
  if (fs.existsSync(packaged)) return packaged;
  return path.resolve(__dirname, '..', 'resources', 'pi-node');
}

function userEngineRoot() {
  return path.join(app.getPath('userData'), 'pi-node');
}

function resourcesRoot() {
  const user = userEngineRoot();
  // Treat it as usable only if the pi entrypoint is actually there (a half-copied
  // or half-installed dir must not shadow the working bundle).
  const isWin = process.platform === 'win32';
  const userPi = path.join(user, isWin ? 'pi.cmd' : 'pi');
  if (fs.existsSync(userPi)) return user;
  return bundledResourcesRoot();
}

function bundledNodeBinary() {
  const isWin = process.platform === 'win32';
  return path.join(resourcesRoot(), isWin ? 'node.exe' : 'node');
}

function bundledPiBinary() {
  const isWin = process.platform === 'win32';
  // Windows: pi.cmd (batch file); macOS/Linux: pi (executable shell script)
  return path.join(resourcesRoot(), isWin ? 'pi.cmd' : 'pi');
}

function binaryPath() {
  // Packaged app: resources/pi-server[.exe] sits next to the app bundle (electron-builder
  // "extraResources"). Dev mode: the same file straight from the repo.
  // Windows: pi-server.exe; macOS/Linux: pi-server (Mach-O or ELF binary).
  //
  // macOS ships as two .dmgs (arm64 + x64). CI copies the arm64 build to
  // `pi-server` and the Intel build to `pi-server-x64`, and BOTH files are bundled
  // into BOTH dmgs (extraResources isn't arch-split). So on an Intel Mac we must
  // pick `pi-server-x64` or we'd try to exec an arm64 binary. Windows and Linux
  // are single-arch here — `candidates` is just `['pi-server(.exe)']` and the
  // lookup below is byte-for-byte the same as before for them.
  const isWin = process.platform === 'win32';
  let candidates;
  if (isWin) {
    candidates = ['pi-server.exe'];
  } else if (process.platform === 'darwin' && process.arch === 'x64') {
    candidates = ['pi-server-x64', 'pi-server'];
  } else {
    candidates = ['pi-server'];
  }
  for (const name of candidates) {
    const packaged = path.join(process.resourcesPath, name);
    if (fs.existsSync(packaged)) return packaged;
    const dev = path.resolve(__dirname, '..', 'resources', name);
    if (fs.existsSync(dev)) return dev;
  }
  // Nothing on disk — return the conventional path so the caller's existence
  // check surfaces a clear "binary not found" error.
  return path.resolve(__dirname, '..', 'resources', candidates[candidates.length - 1]);
}

function ensureBinaryExecutable() {
  if (process.platform === 'win32') return; // Windows doesn't need chmod
  const bin = binaryPath();
  if (!fs.existsSync(bin)) return;
  try {
    // Make sure the binary has execute permissions (755)
    fs.chmodSync(bin, 0o755);
  } catch (err) {
    console.warn(`Failed to chmod ${bin}:`, err.message);
  }
}

function paths() {
  const dir = path.join(app.getPath('userData'), 'pi-server');
  return {
    dir,
    config: path.join(dir, 'config.toml'),
    db: path.join(dir, 'pi-server.db'),
    credentials: path.join(dir, 'admin-credentials.json'),
    // Power-user escape hatches (see ensureConfig / writeModelsJson). Absent by
    // default; when present they let someone drive pi exactly like the standalone
    // CLI — a full replacement config, and/or extra model providers — without the
    // app clobbering it on the next launch.
    customConfig: path.join(dir, 'config.custom.toml'),
    customModels: path.join(dir, 'models.custom.json'),
  };
}

/** Reads a JSON file, returning `fallback` on any problem (missing / malformed /
 *  unreadable) — never throws, so a bad hand-edited override can't stop the
 *  server from starting. */
function readJsonSafe(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch (err) {
    console.warn(`[pi-server] ignoring malformed ${path.basename(file)}: ${err.message}`);
    return fallback;
  }
}

/** pi-server (and the `pi` CLI it spawns) resolve `~` and their `.pi/agent/*` config
 *  files against the HOME env var (backend/src/config/mod.rs falls back to "/root"
 *  when HOME is unset — a Unix assumption that silently breaks on Windows, where
 *  Electron's own process usually has no HOME set at all). Pointing HOME at the
 *  tray app's own userData folder — not the machine's real Windows profile — gives
 *  every install (including a developer's own machine that already has a personal
 *  `pi` CLI configured, with its own extensions/models/sessions) a clean, isolated
 *  `.pi` state that behaves identically everywhere, instead of silently inheriting
 *  or colliding with whatever else happens to already be on that machine. */
function realHome() {
  return app.getPath('userData');
}

function modelsJsonPath() {
  return path.join(realHome(), '.pi', 'agent', 'models.json');
}

// Same router the phone's Chat mode already uses (session4's "ONE MODEL, NOT FOUR"
// decision) — Agent mode bills against the exact same gateway quota/entitlement,
// per the user's explicit requirement, not a separate provider key.
const GATEWAY_URL = 'https://api.ssv.asia'; // custom domain (verified 2026-08-29); was expert-ai-gateway.arthouse.workers.dev
const GATEWAY_MODEL_ID = 'openrouter/unlimited';

// Phase 1 of the product's real target use case (knowledge workers, starting with
// Obsidian vault management before PDF/PPTX/other document work later): the agent
// already gets real file/bash access to whatever folder is picked in "Allowed
// folder" — pointing that at a vault gives it read/write access already. What was
// missing is behavior: without this, it has no reason to know Obsidian's actual
// conventions and would happily write plain, un-vault-shaped markdown. This is
// deliberately just a system prompt — no new MCP servers or skill packages wired
// in yet, that's the next step once this baseline is confirmed working.
// This is injected into the generated config.toml as [chat] system_prompt
// (see ensureConfig below), JSON.stringify-escaped, so it is NOT passed as a
// CLI argument and is safe from cmd.exe/pi.cmd batch-file argument parsing.
// HISTORICAL NOTE: an earlier version DID pass this via --append-system-prompt,
// which on Windows went through pi.cmd (a batch file) and crashed the agent
// spawn ("batch file arguments are invalid") on embedded newlines or cmd.exe
// metacharacters (& | < > ^ "). The TOML route avoids that entirely. If this is
// ever moved back to a CLI arg, that constraint returns — keep it a single line
// with none of those characters as a safety margin regardless.
// Kept deliberately short: pi-server re-passes this as a single `--append-system-prompt`
// CLI arg to `pi.cmd` on EVERY chat-session spawn (backend/src/routes/chat.rs turns the
// config value straight back into a CLI arg — the TOML route does NOT keep it off the
// command line). A ~2KB arg went through cmd.exe's batch-escaping on every spawn; trimming
// it cuts that per-spawn cost and the batch-arg fragility. Behaviour kept, prose dropped.
const OBSIDIAN_SYSTEM_PROMPT =
  "You are managing an Obsidian vault: the allowed folder IS the vault, so treat every .md file as a note. " +
  "Use [[wikilinks]] not markdown links between notes. Preserve and match existing YAML frontmatter, tag style, " +
  "and folder/naming conventions rather than inventing new ones. Use plain markdown, not raw HTML. " +
  "When editing a note keep its structure and voice; check for an existing note before creating a duplicate. " +
  "Never delete or overwrite existing content unless explicitly asked; for anything hard to reverse, say what " +
  "you will do and wait for confirmation. If the user only says hi, briefly say you have read/write/command " +
  "access to their vault folder and understand Obsidian's format, then ask what they want -- two sentences, no menu.";

/** Writes ~/.pi/agent/models.json so the `pi` CLI has exactly one usable model —
 *  the gateway, authenticated with the SAME session token the tray app signed in
 *  with (main/auth.js) — before it ever starts. No "Custom Models" screen, no API
 *  key the user has to find or paste; this is what makes Agent mode "pay and use"
 *  instead of "configure your own LLM provider first". Re-run whenever the signed-in
 *  session changes (see index.js's auth:signIn handler) so a fresh token always
 *  takes effect without the user doing anything.
 *  Format: docs/models.md in the bundled pi-coding-agent package. */
function writeModelsJson(session) {
  const modelsPath = modelsJsonPath();
  fs.mkdirSync(path.dirname(modelsPath), { recursive: true });

  const baseProviders = session?.token
    ? {
        'expert-ai-gateway': {
          baseUrl: `${GATEWAY_URL}/v1`,
          api: 'openai-completions',
          apiKey: session.token,
          models: [
            {
              id: GATEWAY_MODEL_ID,
              name: 'Expert AI',
              // The gateway's "unlimited" router serves GPT-OSS-class reasoning models,
              // which genuinely support variable reasoning effort via OpenRouter's
              // `reasoning` field. This was hardcoded false, which is what made the
              // phone/Settings thinking-level selector always report back "off" no
              // matter what a user picked — the agent had no idea this model could
              // think at all. Declaring it true is what lets that selector actually
              // take effect.
              reasoning: true,
              input: ['text'],
              contextWindow: 128000,
              maxTokens: 8192,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              // pi-ai's `openai-completions` API defaults to OpenAI's own reasoning
              // shape (`reasoning_effort: "medium"`) — but this baseUrl is our own
              // gateway, which forwards the payload straight through to OpenRouter
              // unmodified (see worker's orPayload — it never rewrites a `reasoning`
              // field). OpenRouter's actual API expects `reasoning: { effort }`, not
              // `reasoning_effort`, so without this override the field pi-ai sends
              // would be silently ignored by OpenRouter entirely.
              // Our gateway accepts OpenAI chat roles except `developer`.
              // pi-ai otherwise infers developer-role support for this custom
              // provider when reasoning is enabled, and the first greeting is
              // rejected by the gateway as a malformed request.
              compat: {
                thinkingFormat: 'openrouter',
                supportsDeveloperRole: false,
                maxTokensField: 'max_tokens',
              },
            },
          ],
        },
      }
    : {};

  // Power-user extension: models.custom.json ({ "providers": { ... } } in the same
  // shape pi-ai expects) is merged over the generated gateway provider. Someone can
  // add Anthropic / OpenAI / a local model / their own OpenRouter key and pick it
  // in the phone's model selector — exactly like configuring standalone pi. A
  // provider key that collides replaces ours; anything else is added alongside.
  const custom = readJsonSafe(paths().customModels, null);
  const customProviders =
    custom && typeof custom.providers === 'object' && custom.providers ? custom.providers : {};
  const providers = { ...baseProviders, ...customProviders };

  fs.writeFileSync(modelsPath, JSON.stringify({ providers }, null, 2), 'utf-8');
}

function runBinary(bin, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(`exit ${code}: ${out}`))));
  });
}

/** Generates the admin credentials + config.toml on first run. Idempotent — reuses
 *  what's already there on subsequent launches, matching "install and use" (no
 *  password prompt, no interactive `pi-server init`). */
async function ensureConfig(workdir, relayUrl, session) {
  const p = paths();
  fs.mkdirSync(p.dir, { recursive: true });

  let creds;
  if (fs.existsSync(p.credentials)) {
    creds = JSON.parse(fs.readFileSync(p.credentials, 'utf-8'));
  } else {
    const password = crypto.randomBytes(18).toString('base64url');
    // `hash-password` prints a full TOML line — `password_hash = "$2b$..."` — not a
    // bare hash, so extract just the quoted value instead of using the line as-is.
    const hashOut = await runBinary(binaryPath(), ['hash-password', password]);
    const match = hashOut.match(/password_hash\s*=\s*"([^"]+)"/);
    if (!match) throw new Error(`Unexpected hash-password output: ${hashOut}`);
    creds = { username: 'admin', password, passwordHash: match[1] };
    fs.writeFileSync(p.credentials, JSON.stringify(creds, null, 2), { mode: 0o600 });
  }

  writeModelsJson(session);

  // ── Full-replacement escape hatch ─────────────────────────────────────────
  // If config.custom.toml exists and looks structurally sane, use it verbatim —
  // the tray then drives pi-server exactly like a hand-run `pi-server --config`,
  // with the operator in total control (extensions, ttls, remote mode, a totally
  // different system prompt, extra tables pi-server may add in future, …). We only
  // sanity-check that the mandatory sections are present so a typo can't brick the
  // server silently; anything past that is the operator's call.
  try {
    if (fs.existsSync(p.customConfig)) {
      const custom = fs.readFileSync(p.customConfig, 'utf-8');
      if (/\[\s*server\s*\]/.test(custom) && /password_hash\s*=/.test(custom)) {
        fs.writeFileSync(p.config, custom, 'utf-8');
        console.log('[pi-server] using operator config.custom.toml verbatim');
        return { ...p, creds };
      }
      console.warn('[pi-server] config.custom.toml missing [server]/password_hash — ignoring it');
    }
  } catch (err) {
    console.warn(`[pi-server] could not read config.custom.toml: ${err.message}`);
  }

  // ── Otherwise: generated config, with three knobs from agent-settings.json ──
  //   { "systemPrompt": string|null, "noTools": bool, "extensions": string[],
  //     "packageName": string }
  // null systemPrompt = the vault-aware default; "" = no system prompt at all.
  const knobs = readJsonSafe(path.join(p.dir, 'agent-settings.json'), {});
  const systemPrompt =
    knobs.systemPrompt === undefined || knobs.systemPrompt === null
      ? OBSIDIAN_SYSTEM_PROMPT
      : String(knobs.systemPrompt);
  const noTools = knobs.noTools === undefined ? false : !!knobs.noTools;
  const extensions = Array.isArray(knobs.extensions) ? knobs.extensions : [];
  const packageName =
    typeof knobs.packageName === 'string' && knobs.packageName.trim()
      ? knobs.packageName.trim()
      : '@mariozechner/pi-coding-agent';

  const chatLines = [`cwd = ${JSON.stringify(workdir)}`, `no_tools = ${noTools}`];
  if (systemPrompt !== '') chatLines.push(`system_prompt = ${JSON.stringify(systemPrompt)}`);

  const configToml = `[server]
port = ${PI_SERVER_PORT}
host = "0.0.0.0"
remote = false

[auth]
username = "${creds.username}"
password_hash = "${creds.passwordHash}"

[package]
name = ${JSON.stringify(packageName)}

[chat]
${chatLines.join('\n')}

[paths]
node = ${JSON.stringify(bundledNodeBinary())}
pi = ${JSON.stringify(bundledPiBinary())}

[agent]
# Default []: pi-coding-agent's own default ("npm:@anthaathi/pi-companion-extensions")
# npm-installs a package over the network on every fresh session start — slow/flaky on
# the critical path of "user taps Chat". bash/read/write/edit tools are built into
# pi-coding-agent itself, not that extension. Override via agent-settings.json
# "extensions": ["npm:whatever", ...] to get the full pi extension surface back.
extensions = ${JSON.stringify(extensions)}
`;
  fs.writeFileSync(p.config, configToml, 'utf-8');
  return { ...p, creds };
}

/** Actively confirms nobody is still listening on `port` instead of just trusting
 *  the child's `exit` event — on Windows especially, a just-killed process's socket
 *  can stay bound for a short beat after `exit` fires, so an in-process restart can
 *  race the OS and hit "address already in use" even though we already awaited
 *  stop(). A full app quit+relaunch happens to dodge this purely by taking long
 *  enough for the OS to release it — this polls for the same outcome deliberately,
 *  so Settings' "Restart Server" button is exactly as reliable as quitting the app. */
function waitForPortFree(port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const attempt = () => {
      const socket = net.createConnection({ port, host: '127.0.0.1' });
      socket.once('connect', () => {
        socket.destroy();
        if (Date.now() >= deadline) return resolve(); // give up waiting, try anyway
        setTimeout(attempt, 150);
      });
      socket.once('error', () => {
        socket.destroy();
        resolve(); // nothing listening — port is free
      });
    };
    attempt();
  });
}

/** Returns true if something is currently listening on 127.0.0.1:port. */
function isPortInUse(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host: '127.0.0.1' });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => { socket.destroy(); resolve(false); });
  });
}

/** Force-kill whatever pi-server process is holding `port`. This is the missing
 *  piece that made "Restart Server" unreliable: stop() only kills the child WE
 *  tracked, so a pi-server orphaned by a previous crash/hard-quit kept the port,
 *  the new spawn hit "address already in use", and the retry loop span forever on
 *  "starting" with no QR. We only ever kill a process actually named pi-server on
 *  that port, never anything else. */
function killPortOwner(port) {
  try {
    if (process.platform === 'win32') {
      const out = spawnSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8' }).stdout || '';
      const pids = new Set();
      for (const line of out.split(/\r?\n/)) {
        if (!/LISTENING/i.test(line)) continue;
        if (!new RegExp(`[:.]${port}\\b`).test(line)) continue;
        const m = line.trim().match(/(\d+)\s*$/);
        if (m) pids.add(m[1]);
      }
      for (const pid of pids) {
        // Only kill it if it's actually a pi-server process, never something else
        // that happens to have grabbed the port.
        const tl = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' }).stdout || '';
        if (/pi-server\.exe/i.test(tl)) {
          spawnSync('taskkill', ['/F', '/PID', pid], { encoding: 'utf8' });
          console.log(`[pi-server] force-killed orphan pi-server (pid ${pid}) holding port ${port}`);
        }
      }
    } else {
      const out = spawnSync('lsof', ['-t', `-i:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).stdout || '';
      for (const pid of out.split(/\s+/).filter(Boolean)) {
        spawnSync('kill', ['-9', pid], { encoding: 'utf8' });
        console.log(`[pi-server] force-killed orphan holding port ${port} (pid ${pid})`);
      }
    }
  } catch (e) {
    console.warn(`[pi-server] killPortOwner(${port}) failed: ${e.message}`);
  }
}

/** Guarantee the port is free before we rebind: wait for a graceful release, and
 *  if something is STILL holding it, force-kill the orphan and wait once more. */
async function ensurePortFree(port) {
  await waitForPortFree(port);
  if (await isPortInUse(port)) {
    killPortOwner(port);
    await waitForPortFree(port);
  }
}

const RETRY_DELAYS_MS = [5000, 10000, 20000, 40000, 60000];

class PiServerManager {
  constructor({ store, onStatusChange, onPaired }) {
    this.store = store;
    this.onStatusChange = onStatusChange || (() => {});
    this.onPaired = onPaired || (() => {});
    this.child = null;
    this.status = 'stopped';
    this.log = '';
    this.lastSession = null;
    this.lastRelayUrl = null;
    this.retryCount = 0;
    this.retryTimer = null;
    this.stopping = false;
    this.paired = false;
    this._approving = false;
    // Foolproof pairing approval — see _armPairing(). A standing "y" is kept
    // buffered in pi-server's stdin so its blocking read_line (backend
    // terminal.rs) returns instantly on any pair request, instead of racing to
    // detect + answer the prompt inside the phone's ~4s pairing timeout.
    this._stdoutTail = '';   // rolling tail so a phrase split across two stdout chunks is still matched
    this._pairArmTimer = null;
    this._pendingYs = 0;     // approx count of unconsumed "y\n" we've buffered (bounded top-up)
    this._armed = false;
    this._inviteAccessToken = null;
  }

  /** `session` is optional — omit it to keep whatever was last passed (so an
   *  in-app "Restart server" click, which doesn't know the session, doesn't wipe
   *  out the gateway model config that sign-in wrote). Pass it explicitly right
   *  after sign-in so the newly-issued token takes effect immediately. */
  async start(relayUrl, session) {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.stopping = false;
    this.lastRelayUrl = relayUrl;
    if (session !== undefined) this.lastSession = session;

    // Make sure any previous instance is actually gone (not just asked to stop)
    // before spawning a new one, and start the QR log fresh — otherwise old QR
    // blocks from a dead process stay stacked in the display alongside the new
    // one, and scanning the wrong (stale) one hangs forever at "waiting for
    // approval" since nothing is listening on the other end of it anymore.
    await this.stop();
    // Confirm the port is actually free before rebinding — and if a previous
    // pi-server was orphaned (crash/hard-quit) and still holds it, force-kill it
    // so Restart Server can't get wedged on "starting" with no QR. See
    // ensurePortFree/killPortOwner.
    await ensurePortFree(PI_SERVER_PORT);
    this.log = '';
    this.lastError = null;
    this.paired = false;
    this._approving = false;
    this._stdoutTail = '';
    this._pendingYs = 0;
    this._armed = false;
    this._inviteAccessToken = null;
    this._stopPairingArm();

    // Ensure binary has execute permissions (macOS/Linux)
    ensureBinaryExecutable();

    const workdir = this.store.get('workdir');
    const p = await ensureConfig(workdir, relayUrl, this.lastSession);

    this._setStatus('starting');
    // Both HOME (what pi-server's own Rust code reads — backend/src/config/mod.rs)
    // and USERPROFILE (what Node's os.homedir() actually reads on Windows — the
    // `pi` CLI itself, being a Node program, ignores HOME entirely here) need to
    // point at the same isolated directory, or the two halves silently disagree
    // about where `~/.pi/agent/*` lives and never see each other's config.
    const isolatedHome = realHome();
    // pi-server only prints its QR when it has no active auth session in its own db
    // (backend/src/server/mod.rs) — sensible for its original CLI use, but wrong
    // here: Settings should always be able to show a fresh QR on demand (re-pairing
    // a phone, adding a second one, or just because the user opened Settings),
    // regardless of whether some earlier session is still technically valid.
    // `--qr` forces it every launch.
    const binPath = binaryPath();
    // Check if binary exists before spawn
    if (!fs.existsSync(binPath)) {
      this.lastError = `pi-server binary not found at ${binPath}. Make sure the app was installed correctly.`;
      this._setStatus('error');
      return;
    }

    // Check if binary is executable (macOS/Linux)
    if (process.platform !== 'win32') {
      try {
        fs.accessSync(binPath, fs.constants.X_OK);
      } catch (e) {
        this.lastError = `pi-server binary exists but is not executable. Fixed automatically on next restart.`;
        this._setStatus('error');
        return;
      }
    }

    const child = spawn(binPath, ['--config', p.config, '--db', p.db, '--qr'], {
      windowsHide: true,
      shell: false,
      env: {
        ...process.env,
        EXPERT_AI_RELAY_URL: relayUrl,
        HOME: isolatedHome,
        USERPROFILE: isolatedHome,
        // pi-server defaults to `pi_server=debug,tower_http=debug` — that's ~5-10
        // stdout lines per HTTP request, and during an active chat every one of
        // them is piped to this process, appended to the log buffer, sliced, and
        // regex-scanned. Quieting it to info/warn removes that per-request churn
        // from the main process (which is also what shuttles pairing stdin/stdout)
        // with no loss of anything actionable — pairing, spawns, errors and the QR
        // are all info-level or plain println!.
        RUST_LOG: process.env.RUST_LOG || 'pi_server=info,tower_http=warn',
      },
    });
    this.child = child;

    child.on('error', (err) => {
      const errorMsg = err.code === 'ENOENT'
        ? `pi-server binary not found or not executable`
        : `Failed to start pi-server: ${err.message}`;
      this.lastError = errorMsg;
      this._setStatus('error');
    });

    child.stdout.on('data', (d) => {
      this._log(d);
      this._maybeAutoApprovePairing(d);
    });
    child.stderr.on('data', (d) => {
      this._log(d);
      this._maybeAutoApprovePairing(d);
    });
    child.on('exit', (code) => {
      if (this.child === child) this.child = null;
      // `child.__deliberatelyStopped` (set by stop(), on this exact process
      // instance) — not `this.stopping` or `this.child` — is what tells us
      // whether this exit is a real crash or just an old instance we killed
      // ourselves while restarting/quitting finally getting around to exiting.
      // Only a real crash should ever schedule a retry.
      if (child.__deliberatelyStopped) return;
      if (code !== 0) {
        // Surfaced in Settings — e.g. "address already in use" from a stray
        // process still holding the port. Silent failures here are exactly what
        // caused pairing to hang against a QR from a process that never bound.
        this.lastError = this.log.includes('Only one usage of each socket address')
          ? 'Port 5454 is already in use by another pi-server process. Quit any other Expert AI Agent windows, then Restart server below.'
          : `pi-server exited unexpectedly (code ${code}). Retrying in the background — see the log below.`;
        this._setStatus('error');
        this._scheduleRetry();
      } else {
        this._setStatus('stopped');
      }
    });

    // Give it a moment to bind the port before reporting "running" — pi-server has
    // no explicit "ready" signal on stdout we can key off cheaply, so this is a
    // pragmatic wait, not a real health check.
    await new Promise((r) => setTimeout(r, 1500));
    if (this.child) {
      this.retryCount = 0;
      this._setStatus('running');
    } else {
      this._setStatus('stopped');
    }
  }

  /** "It just works, and if it fails it quietly tries again" — a user who can't
   *  read a stack trace should never have to click "Restart server" themselves for
   *  a transient failure (an antivirus scan holding a file lock, a slow machine
   *  still finishing boot, a one-off port collision). Bounded, backed off, and
   *  reset to zero on the next clean start so a real persistent problem doesn't
   *  retry forever in a tight loop. */
  _scheduleRetry() {
    if (this.retryTimer || this.stopping) return;
    const delay = RETRY_DELAYS_MS[Math.min(this.retryCount, RETRY_DELAYS_MS.length - 1)];
    this.retryCount += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.start(this.lastRelayUrl, this.lastSession).catch(() => {
        /* start() already records lastError/status on failure */
      });
    }, delay);
  }

  /** Waits for the process to actually exit, not just for kill() to be called —
   *  a fire-and-forget kill let a new instance start while the old one was still
   *  shutting down (or, if kill somehow failed, left it running as an orphan on
   *  the same port, silently answering with a QR nobody could still pair against). */
  stop() {
    this._stopPairingArm();
    if (!this.child) {
      this._setStatus('stopped');
      return Promise.resolve();
    }
    const child = this.child;
    child.__deliberatelyStopped = true;
    return new Promise((resolve) => {
      const done = () => {
        if (this.child === child) this.child = null;
        this._setStatus('stopped');
        resolve();
      };
      child.once('exit', done);
      child.kill();
      // Windows kill() is normally immediate (TerminateProcess), but don't hang
      // the caller forever if it somehow doesn't fire.
      setTimeout(done, 3000);
    });
  }

  /** For a deliberate, final shutdown (app quit) — unlike stop(), which start()
   *  also calls internally before every respawn and must NOT suppress retries. */
  shutdown() {
    this.stopping = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    return this.stop();
  }

  /** Write one "y\n" into pi-server's stdin, tracking a bounded outstanding count. */
  _writeY() {
    try {
      if (this.child?.stdin?.writable) {
        this.child.stdin.write('y\n');
        this._pendingYs += 1;
        return true;
      }
    } catch { /* pipe closed mid-write — nothing to do */ }
    return false;
  }

  /** FOOLPROOF pairing approval.
   *
   *  pi-server's approval is a blocking terminal Y/N prompt (backend
   *  terminal.rs prompt_terminal_approval): its approval task polls for a
   *  pending pair request every 500ms (server/mod.rs spawn_pairing_approval_task),
   *  prints a "PAIRING REQUEST" box, then blocks on read_line. The phone's
   *  /api/auth/pair call gives up after ~4s. The OLD approach ("watch stdout for
   *  the box, then type y") was fragile two ways: (1) it raced the 4s budget
   *  against the 500ms poll + box render + pipe round-trip + DB writes, and
   *  (2) Node splits piped stdout at arbitrary byte boundaries, so "PAIRING
   *  REQUEST" split across two 'data' chunks matched NOTHING and it hung forever.
   *
   *  Fix: don't react at all — PRE-ARM. Keep a standing "y\n" sitting in
   *  pi-server's stdin buffer from the moment the server is up. read_line then
   *  returns instantly the moment the 500ms poll surfaces the request, so the
   *  whole handshake finishes in ~500ms, with zero dependence on catching a log
   *  line. After the server is up, prompt_terminal_approval is the ONLY thing
   *  that reads stdin (password/init prompts all run earlier, before the QR is
   *  printed), so a buffered "y" can only ever be consumed by an approval.
   *
   *  Auto-approving matches the "auto-run, no confirm prompts" default already
   *  chosen for this app — the pairing code/QR itself is the trust boundary. */
  _armPairing() {
    if (this._armed) return;
    this._armed = true;
    console.log('[pi-server] pairing pre-armed (standing "y" buffered in stdin)');
    this._pendingYs = 0;
    this._writeY();                       // one standing "y" ready before any request arrives
    if (this._pairArmTimer) clearInterval(this._pairArmTimer);
    // Bounded top-up: while unpaired, make sure a "y" stays buffered (in case the
    // pre-armed one was consumed and we didn't observe the ACCEPTED line). Capped
    // so buffered lines never accumulate unbounded across a long session.
    this._pairArmTimer = setInterval(() => {
      if (!this.child?.stdin?.writable) return;
      if (this.paired) return;
      if (this._pendingYs < 4) this._writeY();
    }, 1000);
  }

  _stopPairingArm() {
    if (this._pairArmTimer) {
      clearInterval(this._pairArmTimer);
      this._pairArmTimer = null;
    }
    this._armed = false;
  }

  _maybeAutoApprovePairing(chunk) {
    // Scan a rolling tail + this chunk so a phrase split across two stdout data
    // events is still matched. Cap the retained tail so it can't grow.
    const s = this._stdoutTail + chunk.toString();
    this._stdoutTail = s.slice(-256);
    if (!this.child?.stdin?.writable) return;

    if (/Pairing ACCEPTED/i.test(s)) {
      if (this._approveStartedAt) {
        console.log(`[pi-server] pairing approved in ${Date.now() - this._approveStartedAt}ms`);
        this._approveStartedAt = null;
      }
      // A pairing just consumed a buffered "y" — reset the count and re-arm one
      // for the next device. Clear the tail so this same line doesn't re-trigger.
      this._pendingYs = 0;
      this._stdoutTail = '';
      this._writeY();
      this.onPaired();
      return;
    }

    // Backup path (the pre-arm should already have handled it): if we DO catch the
    // request box, note the timing and top up immediately in case the buffer was
    // momentarily empty.
    if (!/PAIRING REQUEST|waiting for terminal approval/i.test(s)) return;
    if (this._approving) return;
    this._approving = true;
    this._approveStartedAt = Date.now();
    console.log('[pi-server] pairing request seen — ensuring "y" is buffered');
    this._writeY();
    let n = 0;
    const t = setInterval(() => {
      if (this._pendingYs < 4) this._writeY();
      if (++n >= 30 || !this.child?.stdin?.writable) {
        clearInterval(t);
        this._approving = false;
      }
    }, 130);
  }

  getLog() {
    return this.log;
  }

  /** pi-server's --qr output prints both a glyph-art QR (for terminal viewing) AND
   *  the plain pi://connect?... URL it encodes, on their own lines. The glyph art
   *  is unreliable to re-render pixel-perfect (half-block Unicode chars under font
   *  smoothing/subpixel rendering blur and misalign easily); the plain URL is exact
   *  and lets Settings draw a real QR image with a proper library instead. Returns
   *  the LAST such URL in the log (a fresh one is printed each --qr restart, and
   *  the log can contain output from more than one run).
   */
  getConnectUrl() {
    const matches = this.log.match(/pi:\/\/connect\?\S+/g);
    return matches && matches.length ? matches[matches.length - 1] : null;
  }

  async getFreshConnectUrl() {
    const existing = this.getConnectUrl();
    const fallback = this.paired ? null : existing;
    if (!existing || !this.child || this.status !== 'running') return fallback;
    const creds = this.getCredentials();
    if (!creds?.username || !creds?.password) return fallback;
    try {
      if (!this._inviteAccessToken) {
        const login = await fetch(`http://127.0.0.1:${PI_SERVER_PORT}/api/auth/login`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username: creds.username, password: creds.password }),
          signal: AbortSignal.timeout(2500),
        });
        if (!login.ok) return fallback;
        this._inviteAccessToken = (await login.json())?.data?.access_token;
      }
      if (!this._inviteAccessToken) return fallback;
      const response = await fetch(`http://127.0.0.1:${PI_SERVER_PORT}/api/auth/invite`, {
        method: 'POST', headers: { authorization: `Bearer ${this._inviteAccessToken}` },
        signal: AbortSignal.timeout(2500),
      });
      if (response.status === 401) this._inviteAccessToken = null;
      if (!response.ok) return fallback;
      const invite = (await response.json())?.data;
      if (!invite?.qr_id || !invite?.server_id) return fallback;
      const parsed = new URL(existing.replace(/^pi:\/\//, 'https://pi.local/'));
      parsed.searchParams.set('qr_id', invite.qr_id);
      parsed.searchParams.set('server_id', invite.server_id);
      return 'pi://' + parsed.href.slice('https://pi.local/'.length);
    } catch {
      return fallback;
    }
  }

  getLastError() {
    return this.lastError || null;
  }

  getCredentials() {
    try {
      return JSON.parse(fs.readFileSync(paths().credentials, 'utf-8'));
    } catch {
      return null;
    }
  }

  _setStatus(status) {
    this.status = status;
    this.onStatusChange(status);
  }

  _log(chunk) {
    // Kept for Settings' "Pairing" panel — pi-server prints its own real QR/connect
    // URL to stdout (see backend/src/services/connection.rs's print_qr), this is the
    // only way to surface it since it has no API endpoint for it. Capped so a long
    // session doesn't grow this unbounded.
    this.log += chunk.toString();
    if (this.log.length > 20000) this.log = this.log.slice(-20000);
    if (!app.isPackaged) process.stdout.write(`[pi-server] ${chunk}`);

    // The server is fully up (past any startup password/init stdin prompts) once
    // it has printed its connect URL. That's the safe moment to pre-arm pairing —
    // see _armPairing(). Doing it earlier risks a buffered "y" being eaten by a
    // startup prompt instead of an approval.
    if (!this._armed && this.log.includes('pi://connect')) {
      this._armPairing();
    }

    // The Settings "Agent" pill needs a real signal for "a phone has actually
    // paired", distinct from the off-WiFi relay's own peer-connected status
    // (which stays unset for the common same-WiFi case and would otherwise
    // leave the pill stuck on "Pairing pending" forever even once a phone is
    // genuinely connected). "Pairing ACCEPTED" (terminal.rs) fires on a brand
    // new handshake; a later 200 on /api/auth/session covers a phone that
    // reconnects using its already-saved token after a server restart, with
    // no new pairing prompt to key off of.
    if (!this.paired && /Pairing ACCEPTED/.test(this.log)) {
      this.paired = true;
    } else if (!this.paired && /uri=\/api\/auth\/session[\s\S]{0,300}?status=200/.test(this.log)) {
      this.paired = true;
    }
  }

  isPaired() {
    return this.paired;
  }
}

module.exports = { PiServerManager, PI_SERVER_PORT, resourcesRoot };
