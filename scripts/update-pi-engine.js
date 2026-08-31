#!/usr/bin/env node
/**
 * Updates the bundled pi engine (resources/pi-node) to the latest published
 * @earendil-works/pi-coding-agent, then smoke-tests it.
 *
 * WHY a script and not a runtime auto-updater: a packaged Electron app ships no
 * npm, and Expert AI Agent must run the LATEST pi while the machine's other
 * pi-based products (Expert AI Terminal / Terminal Pro / Expert OS) stay on their
 * own older global install. The clean place to pick up "latest" is the build:
 * run this before `npm run build:win`, verify, ship. resources/pi-node is a
 * self-contained tree — nothing here touches a global install.
 *
 * Usage:
 *   node scripts/update-pi-engine.js                # -> @earendil-works/pi-coding-agent@latest
 *   node scripts/update-pi-engine.js 0.84.3         # pin a specific version
 *
 * Safety: writes to resources/pi-node.next first, smoke-tests `--version` AND an
 * `--mode rpc` handshake, and only swaps it into place if both pass. The previous
 * tree is kept as resources/pi-node.prev for one-command rollback.
 */
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const PKG = '@earendil-works/pi-coding-agent';
const version = process.argv[2] || 'latest';
const root = path.resolve(__dirname, '..', 'resources');
const cur = path.join(root, 'pi-node');
const next = path.join(root, 'pi-node.next');
const prev = path.join(root, 'pi-node.prev');
const isWin = process.platform === 'win32';
const nodeBin = path.join(cur, isWin ? 'node.exe' : 'node');
const npmCmd = isWin ? 'npm.cmd' : 'npm';

function sh(cmd, args, opts) {
  console.log(`$ ${cmd} ${args.join(' ')}`);
  return execFileSync(cmd, args, { stdio: 'inherit', ...opts });
}

if (!fs.existsSync(nodeBin)) {
  console.error(`No bundled node at ${nodeBin} — run scripts/setup-binaries.js first.`);
  process.exit(1);
}

// 1. Fresh copy of the current tree, minus node_modules, as the staging dir.
fs.rmSync(next, { recursive: true, force: true });
fs.mkdirSync(next, { recursive: true });
for (const entry of fs.readdirSync(cur)) {
  if (entry === 'node_modules' || entry.startsWith('pi-node.')) continue;
  fs.cpSync(path.join(cur, entry), path.join(next, entry), { recursive: true });
}
fs.writeFileSync(
  path.join(next, 'package.json'),
  JSON.stringify(
    { name: 'pi-node-bundle', private: true, dependencies: { [PKG]: version === 'latest' ? 'latest' : version } },
    null,
    2,
  ),
);

// 2. Install into the staging dir.
sh(npmCmd, ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: next });

const cli = path.join(next, 'node_modules', ...PKG.split('/'), 'dist', 'cli.js');
if (!fs.existsSync(cli)) {
  console.error(`Install produced no ${cli}`);
  process.exit(1);
}

// 3a. --version smoke test.
const stagedNode = path.join(next, isWin ? 'node.exe' : 'node');
const v = execFileSync(stagedNode, [cli, '--version'], { encoding: 'utf-8' }).trim();
console.log(`Installed ${PKG}@${v}`);

// 3b. RPC handshake smoke test — spawn `--mode rpc`, expect a JSON line on stdout
//     within 10s, then exit. This is the exact path pi-server drives.
const ok = () =>
  new Promise((resolve) => {
    const child = spawn(stagedNode, [cli, '--mode', 'rpc'], { stdio: ['pipe', 'pipe', 'ignore'] });
    let sawJson = false;
    const done = (result) => {
      try { child.kill(); } catch {}
      resolve(result);
    };
    const timer = setTimeout(() => done(false), 10000);
    child.stdout.on('data', (d) => {
      for (const line of d.toString().split('\n')) {
        const t = line.trim();
        if (t.startsWith('{') && t.endsWith('}')) {
          try { JSON.parse(t); sawJson = true; } catch {}
        }
      }
      if (sawJson) { clearTimeout(timer); done(true); }
    });
    child.on('error', () => { clearTimeout(timer); done(false); });
  });

ok().then((passed) => {
  if (!passed) {
    console.error('RPC handshake smoke test FAILED — leaving current engine in place.');
    fs.rmSync(next, { recursive: true, force: true });
    process.exit(1);
  }
  // 4. Swap into place, keeping the old one for rollback.
  fs.rmSync(prev, { recursive: true, force: true });
  fs.renameSync(cur, prev);
  fs.renameSync(next, cur);
  console.log(`\n✓ pi engine updated to ${PKG}@${v}`);
  console.log(`  rollback: rm -rf resources/pi-node && mv resources/pi-node.prev resources/pi-node`);
});
