// Spawns and manages the REAL pi-server binary (backend/, compiled from
// pico-upstream — this IS the Pico mobile app's actual backend, same generated
// API client the app already speaks). Expert AI Agent's job is exactly what the
// user asked: a settings dashboard that pairs and keeps this running — not its
// own agent implementation. That's what pi-server itself does, managing the real
// `pi` coding-agent underneath (see backend/src/config/mod.rs's [package] setting).
const { spawn } = require('node:child_process');
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');

const PI_SERVER_PORT = 5454;

// The whole point of a white-labeled tray app: nobody who installs it should ever
// need Node.js, npm, or a hand-configured API key already on their machine. A full
// portable Node + the real @earendil-works/pi-coding-agent package (already
// installed, no npm-install-on-first-run step) ships inside resources/pi-node/, and
// pi-server.js points pi-server's own [paths] config directly at it — so
// `get_agent_runtime_status` (backend/src/services/runtime.rs) sees both node and pi
// as "installed" from the very first launch, on a completely clean machine.
function resourcesRoot() {
  const packaged = path.join(process.resourcesPath, 'pi-node');
  if (fs.existsSync(packaged)) return path.join(process.resourcesPath, 'pi-node');
  return path.resolve(__dirname, '..', 'resources', 'pi-node');
}

function bundledNodeBinary() {
  return path.join(resourcesRoot(), 'node.exe');
}

function bundledPiBinary() {
  // pi.cmd (not the extension-less `pi` POSIX shim) — this is a Windows-only tray
  // app right now, same scope as pi-server.exe itself.
  return path.join(resourcesRoot(), 'pi.cmd');
}

function binaryPath() {
  // Packaged app: resources/pi-server.exe sits next to the app bundle (electron-builder
  // "extraResources"). Dev mode: the same file straight from the repo.
  const packaged = path.join(process.resourcesPath, 'pi-server.exe');
  if (fs.existsSync(packaged)) return packaged;
  return path.resolve(__dirname, '..', 'resources', 'pi-server.exe');
}

function paths() {
  const dir = path.join(app.getPath('userData'), 'pi-server');
  return {
    dir,
    config: path.join(dir, 'config.toml'),
    db: path.join(dir, 'pi-server.db'),
    credentials: path.join(dir, 'admin-credentials.json'),
  };
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
const GATEWAY_URL = 'https://expert-ai-gateway.arthouse.workers.dev';
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
const OBSIDIAN_SYSTEM_PROMPT =
  "You are helping manage an Obsidian vault. The allowed folder IS the vault (or a folder inside one) " +
  "-- treat every .md file in it as an Obsidian note, not a generic text file. Follow these conventions " +
  "unless the user's note content clearly indicates otherwise: " +
  "Internal links use Obsidian wikilink syntax, [[Note Name]] or [[Note Name|display text]], not markdown " +
  "[text](path) links, for links to other notes in the vault. " +
  "Preserve and correctly format YAML frontmatter (the --- block at the top of a note) -- tags, aliases, " +
  "dates, and any other properties. Add frontmatter to new notes when the vault's existing notes use it, " +
  "matching their existing schema instead of inventing a new one. " +
  "Tags use #tag-name inline or a frontmatter tags list, matching whatever the surrounding vault already does. " +
  "Respect existing folder structure and naming conventions (e.g. daily notes, project folders) -- look at " +
  "how similar existing notes are organized before creating a new one, rather than defaulting to a flat structure. " +
  "Use standard markdown (headings, lists, tables, code fences, callout blocks) -- never raw HTML unless a note " +
  "already relies on it. When editing an existing note, preserve its structure and voice rather than rewriting " +
  "it wholesale, unless asked to. Before creating a new note, check whether a similar one already exists to " +
  "avoid duplication or broken links. " +
  "If the user's first message in this conversation is a plain greeting (e.g. hi, hey, hello) with no actual " +
  "task in it, do not just greet back -- briefly state what you can do here: you have real read, write, and " +
  "command access to their connected folder, you understand Obsidian's note format (wikilinks, frontmatter, " +
  "tags, existing structure) so you can create and edit notes correctly, and they can ask you to find, write, " +
  "organize, or clean up notes in that folder. Keep it to two or three short sentences, then ask what they'd " +
  "like to do -- don't list this as a bullet menu. Skip this entirely once the conversation has moved past the " +
  "first message. " +
  "Safety, always: never delete, overwrite, or destructively rewrite a user's existing file or note unless " +
  "they explicitly asked for that specific change in this conversation -- when in doubt, keep the original and " +
  "create or propose a new version instead of destroying anything. Before any major or hard-to-reverse action " +
  "(deleting a file, overwriting an existing note's content, running a command that changes many files, moving " +
  "or renaming things in bulk), briefly say what you're about to do and why, and wait for the user to confirm " +
  "before doing it. Small, obviously reversible edits (fixing a typo, adding a section, creating a brand new " +
  "note) don't need this -- reserve confirmation for anything that could lose the user's existing work.";

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

  const providers = session?.token
    ? {
        'expert-ai-gateway': {
          baseUrl: `${GATEWAY_URL}/v1`,
          api: 'openai-completions',
          apiKey: session.token,
          models: [
            {
              id: GATEWAY_MODEL_ID,
              name: 'Expert AI',
              reasoning: false,
              input: ['text'],
              contextWindow: 128000,
              maxTokens: 8192,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      }
    : {};

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

  const configToml = `[server]
port = ${PI_SERVER_PORT}
host = "0.0.0.0"
remote = false

[auth]
username = "${creds.username}"
password_hash = "${creds.passwordHash}"

[package]
name = "@mariozechner/pi-coding-agent"

[chat]
cwd = ${JSON.stringify(workdir)}
no_tools = false
system_prompt = ${JSON.stringify(OBSIDIAN_SYSTEM_PROMPT)}

[paths]
node = ${JSON.stringify(bundledNodeBinary())}
pi = ${JSON.stringify(bundledPiBinary())}

[agent]
# pi-coding-agent's own default ("npm:@anthaathi/pi-companion-extensions") fetches
# a package over the network and installs it via npm on every fresh session start.
# That's a slow, flaky thing to put on the critical path of "user taps Chat" for a
# product that has to work unattended on a stranger's machine — bash/read/write/edit
# tool support is built into pi-coding-agent itself, not part of that extension, so
# skipping it doesn't lose core Agent mode functionality.
extensions = []
`;
  fs.writeFileSync(p.config, configToml, 'utf-8');
  return { ...p, creds };
}

const RETRY_DELAYS_MS = [5000, 10000, 20000, 40000, 60000];

class PiServerManager {
  constructor({ store, onStatusChange }) {
    this.store = store;
    this.onStatusChange = onStatusChange || (() => {});
    this.child = null;
    this.status = 'stopped';
    this.log = '';
    this.lastSession = null;
    this.lastRelayUrl = null;
    this.retryCount = 0;
    this.retryTimer = null;
    this.stopping = false;
    this.paired = false;
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
    this.log = '';
    this.lastError = null;
    this.paired = false;

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
    const child = spawn(binaryPath(), ['--config', p.config, '--db', p.db, '--qr'], {
      windowsHide: true,
      env: { ...process.env, EXPERT_AI_RELAY_URL: relayUrl, HOME: isolatedHome, USERPROFILE: isolatedHome },
    });
    this.child = child;

    child.stdout.on('data', (d) => {
      this._log(d);
      this._maybeAutoApprovePairing(d);
    });
    child.stderr.on('data', (d) => this._log(d));
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

  /** pi-server's pairing approval is a blocking terminal Y/N prompt (see
   *  backend/src/terminal.rs's prompt_terminal_approval) — designed for interactive
   *  CLI use. This app runs it headless with no one to type "y", so without this it
   *  hangs at "waiting for approval" forever. Auto-approving matches the "auto-run,
   *  no confirm prompts" default already chosen for this app — the pairing code/QR
   *  itself is the real trust boundary (only someone who can see this machine's
   *  screen or is on the same relay code can even trigger this prompt). */
  _maybeAutoApprovePairing(chunk) {
    if (chunk.toString().includes('PAIRING REQUEST') && this.child?.stdin?.writable) {
      this.child.stdin.write('y\n');
    }
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

module.exports = { PiServerManager, PI_SERVER_PORT };
