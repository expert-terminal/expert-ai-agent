# CLAUDE.md — Expert AI Agent (desktop tray app)

Authoritative orientation for Claude Code sessions in this repo. Read before changing anything.

Project root: `C:\Users\Win 11\Downloads\desktop app\expert-ai-agent`
Type: Electron tray app (Node/CommonJS `main/`, HTML/JS `renderer/`). Build notes: [BUILD.md](BUILD.md).

---

## 0. The three sibling projects — this app is the MIDDLE of a chain

Phone pairing / Agent-mode chat spans **three separate repos**. A change to the QR
shape, the tunnel frame protocol, or the pairing endpoints in ANY of them breaks the
other two. Keep all three `CLAUDE.md` files in sync when the contract changes.

| Component | Folder | Role |
|---|---|---|
| **APK** (phone) | `C:\expert-ai-apk\expert-ai` | Scans the QR, pairs, runs Agent chat against the saved server address. Has a `CLAUDE.md` §2.5. **Released to production** — treat APK-side changes as needing a full rebuild + store update; avoid depending on unreleased APK behaviour. |
| **Agent tray** (this repo) | `…\desktop app\expert-ai-agent` | Spawns `pi-server.exe`, generates the QR, holds the outbound relay WebSocket, auto-approves pairing. |
| **Relay Worker** | `C:\Users\Win 11\Downloads\Desktop App\expert-ai-link` | Cloudflare Worker at `link.ssv.asia`. Pure rendezvous + HTTP/SSE tunnel. Has a `CLAUDE.md`. Deploy: `npx wrangler deploy` (OAuth `samarvirdi@gmail.com`, acct `6af68c2916e705b64ae6de82433e1e85`). |

Related backend source, NOT in any of these folders:
- pi-server (Rust): built from `C:\expert-ai-apk\pico-upstream` → `resources/pi-server.exe`.
- Gateway Worker (LLM/MCP): `C:\Users\Win 11\Downloads\deep\expert-ai-gateway-serper\v0.2.0-oauth\worker`.

---

## 1. What this app is (and is NOT)

It is a **settings dashboard that pairs a phone and keeps `pi-server` running**. It does
NOT implement any agent logic — `pi-server` (the real Pico backend) does, managing the
`pi` coding-agent under `resources/pi-node/`.

- `main/index.js` — Electron entry: tray menu, Settings window, all IPC handlers,
  orchestrates `PiServerManager` + `RelayClient`.
- `main/pi-server.js` — `PiServerManager`: spawns/monitors `pi-server.exe --qr`, parses
  its stdout for the connect URL, **pre-arms pairing approval**, port-free guards.
- `main/relay.js` — `RelayClient`: the outbound WebSocket to the relay Worker; the
  HTTP/SSE tunnel proxy to local `pi-server`; relay registration self-check.
- `main/auth.js`, `main/store.js`, `main/logger.js` — device login, JSON store
  (`%APPDATA%\expert-ai-agent\config.json`), file logging.
- `renderer/` — the Settings UI (polls `pi-server:get` every ~5 s for status + QR).

pi-server isolation: HOME/USERPROFILE are forced to `<userData>` when spawning, so
`~/.pi` never collides with the other pi-based products on the machine. Engine lives in
`<userData>/pi-node` (user-updatable) falling back to bundled `resources/pi-node`.

---

## 2. Pairing & the relay tunnel — THE hard-won design (Aug 2026)

### 2.1 The QR (`main/index.js`, `ipcMain.handle('pi-server:get')`)
pi-server prints `pi://connect?hostname=…&ips=<~13 addrs>&port=5454&qr_id=…&server_id=…&relay=<EXPERT_AI_RELAY_URL>`.
The `relay=` value comes from the `EXPERT_AI_RELAY_URL` env var passed at spawn
(= `relayClient.getTunnelUrl()` at `start()` time). The `pi-server:get` handler then
**rewrites** that URL before drawing the QR:

- **`relay=` is always overwritten with `relayClient.getTunnelUrl()`'s LIVE code** — the
  spawned-in value goes stale if the code rotates/reconnects.
- **`hostname` is dropped. `localhost` is NEVER included in `ips`** (the APK's
  `connect.tsx resolveBaseUrl` literally prefers an `ips` entry === `"localhost"`).
- **Mode RELAY-ONLY:** when `relayClient.isReady()` is true, `ips` is set to **empty** —
  the QR carries only the relay. This is the whole fix for the "Waiting for approval
  forever" bug: the APK's OS-deep-link screen (`app/connect.tsx`) picks `ips[0]`, has
  **no timeout and no relay fallback**, so any unreachable LAN IP hangs it permanently.
  Empty `ips` forces that screen down its `!preferredHost && params.relay` branch.
- **Mode lan+relay:** only when the relay is NOT confirmed — `ips` = ONE real router-LAN
  IPv4 (or the `192.168.137.x` hotspot IP if that's all there is). Still ≤1 entry so the
  phone never burns 4 s per dead address.
- If neither relay-confirmed nor any LAN IP → QR is withheld (`connectUrl = null`,
  `pairingPending: true`) rather than shipping a dead QR.
- Log line to look for: `[pi-server] pairing QR — mode: RELAY-ONLY, ips: [none], relay: live, relayReady: true`.

### 2.2 Auto-approve (`main/pi-server.js`)
pi-server's pairing approval is a blocking terminal `y/n` prompt; the phone's
`/api/auth/pair` call gives up in ~4 s. **Do not react to stdout — PRE-ARM.** `_armPairing()`
keeps a standing `y\n` buffered in pi-server's stdin from the moment it prints
`pi://connect`; `read_line` returns instantly when the 500 ms approval poll surfaces the
request. `_maybeAutoApprovePairing()` is a backup that also bursts `y\n` on seeing
`PAIRING REQUEST` / `waiting for terminal approval`, and re-arms on `Pairing ACCEPTED`.
`start()` resets `this.log`, `_armed`, `_pendingYs` so a fresh run re-arms cleanly.
Expected: `[pi-server] pairing approved in ~500ms`, no human action.

`start()` also calls `ensurePortFree(5454)` → `waitForPortFree` then `killPortOwner`
(only kills a process whose image is `pi-server.exe`) so a crashed/orphaned instance
can't wedge "Restart Server" on "starting" with no QR.

### 2.3 The relay tunnel frame protocol (`main/relay.js _handleTunnelRequest`)
The Worker sends `{ type:"tunnel_request", id, method, path, headers, body, stream:true }`
on the desktop WS. This handler forwards to `http://127.0.0.1:5454<path>` and replies:

- **health short-circuit:** `path === '/__relay_health'` or an `x-relay-health` header →
  reply `tunnel_response` echoing the nonce, WITHOUT touching pi-server. (Used by 2.4.)
- **one-shot** — response has `Content-Length` and is not `text/event-stream`:
  `{ type:"tunnel_response", id, status, headers, body }`. Hop-by-hop headers
  (`content-length`, `transfer-encoding`, `connection`, `accept-encoding`, …) are
  stripped so `fetch` recomputes them. One 500 ms retry on connection-refused (pi-server
  still binding at startup).
- **streaming** — `text/event-stream`, or chunked, or no `Content-Length`:
  `{ type:"tunnel_head", id, status, headers }` → N × `{ type:"tunnel_chunk", id, data:<base64> }`
  → `{ type:"tunnel_end", id }` (or `{ type:"tunnel_error", id, message }`).
  **Chunks are COALESCED: flush on 16 KB or a 50 ms timer** — never one frame per token,
  or the relay DO gets billed for hundreds of message wakeups per turn. The `fetch`
  abort timer bounds connect + time-to-first-byte only; it's cleared once headers
  arrive so a long SSE stream is not killed. Bails + `reader.cancel()` if the relay WS
  drops mid-stream.

This streaming path is what makes **Agent-mode chat work over the relay**. The one-shot
path MUST stay for pairing / `/api/auth/session` / workspace calls. The tunnel is
HTTP+SSE only — it **cannot carry a WebSocket**.

### 2.4 Relay registration self-check (`main/relay.js`)
The desktop WS can stay `readyState === OPEN` (and answer ping/pong) while the Worker DO
has silently dropped its room registration → `/tunnel/<code>` returns 503. TCP-level
heartbeats do NOT catch this. So:

- `_verifyRegistration()` fetches the desktop's OWN
  `https://link.ssv.asia/tunnel/<code>/__relay_health` with `x-relay-health: <nonce>`;
  the health short-circuit (2.3) echoes the nonce. 503 / timeout / missing-nonce → mark
  `_regConfirmed = false`, one 2 s re-check, then `ws.terminate()` → `close` → backoff
  reconnect → re-register.
- `isReady()` = socket OPEN **AND** `_regConfirmed`. It also fires an opportunistic
  re-check when the last good round-trip is > `REG_STALE_MS` (25 s) old.
- Also present: WS ping/pong heartbeat (CF answers ping frames), exponential-backoff +
  full-jitter reconnect (3 s → 30 s, reset on real `open`).
- **Adaptive interval (CF quota):** `setActive(active)` — 15 s while a pairing is
  expected, **120 s once a phone is paired** (`index.js` calls
  `relayClient.setActive(!piServer.isPaired())` in `refreshTray`). Live tunnel traffic
  already proves the link while chatting.
- Confirmation log: `[relay] registration confirmed — tunnel round-trip OK`.

### 2.5 Cloudflare free-tier rules — obey when touching relay.js
- No new polling loops. The registration check is the only periodic outbound call; keep
  it adaptive.
- Chunk coalescing is mandatory for any streamed body.
- Every tunnel operation must be bounded (the Worker adds a 20 s TTFB guard + 5 min hard
  cap; the desktop must not add unbounded waits).
- Don't hold the relay WS busy when idle — the DO uses the Hibernation API and bills per
  active event.

---

## 3. IPC surface (`main/index.js`)

`settings:get/set/pickFolder`, `pairing:get/rotate`, `auth:getSession/signIn/signOut`,
`pi-server:get` (status + QR + log, polled every 5 s), `pi-server:restart/stop`,
`shell:openExternal` (http(s) only), `diagnostics:get`, `dependencies:check`.

`pi-server:get` return shape includes `connectUrl`, `qrDataUrl` (cached in `qrCache`,
keyed on the exact URL), `paired`, `relayStatus`, `relayReady`, `pairingPending`.

---

## 4. Standing rules (from the project owner — do not violate)

- **Ask permission before building or deploying anything.** Test via `npm start` first;
  only build after the owner confirms it works on a real phone.
- Production stability is paramount — the APK is already in early-access users' hands.
- **Signing:** always use the local `credentials.json` / `android/keystore.properties`
  in the APK repo — never let EAS generate a new keystore. (APK-side concern; noted here
  because sessions often touch both repos.)
- `sentry.properties` / any auth token is SENSITIVE — rotate if leaked.
- Keep this file, the APK `CLAUDE.md` §2.5, and the relay `CLAUDE.md` in agreement.

---

## 5. Pitfall log — already found & fixed once, don't reintroduce

1. **QR with LAN IPs + the `connect.tsx` deep-link screen** = permanent "Waiting for
   approval" (no timeout, no fallback there). Keep the RELAY-ONLY QR when the relay is
   confirmed. (2.1)
2. **`localhost` in `ips`** — `resolveBaseUrl` prefers it; it's unreachable from a phone.
3. **Trusting `ws.readyState === OPEN` as "relay works"** — the DO can de-register a live
   socket. Only `isReady()` (open AND `_regConfirmed`) is trustworthy. (2.4)
4. **Buffering a tunneled response** (`await res.text()` on everything) capped Agent chat
   at the Worker's 15 s DO timeout → zero tokens. Streamed responses MUST use the
   head/chunk/end frames. (2.3)
5. **One WS frame per SSE token** — blows the CF DO message-event budget. Coalesce. (2.3)
6. **Fixed 3 s reconnect with no heartbeat** — a silently-dropped socket never recovers.
   Backoff + ping/pong + registration check. (2.4)
7. **Reacting to pi-server stdout to approve pairing** — Node splits stdout at arbitrary
   byte boundaries; "PAIRING REQUEST" can span two chunks and match nothing. Pre-arm
   stdin instead. (2.2)
8. **Restart racing the OS on port 5454** — `ensurePortFree` / `killPortOwner`. (2.2)
