#!/usr/bin/env node

/**
 * Setup script to download/prepare pi-server and Node binaries for packaging.
 * This must run BEFORE building the Electron app.
 *
 * The pi-server binary is the Pico backend (compiled from pico-upstream).
 * It needs to be pre-built for each platform (Windows, macOS, Linux).
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const RESOURCES_DIR = path.join(__dirname, '..', 'resources');
const PI_NODE_DIR = path.join(RESOURCES_DIR, 'pi-node');

// Platform-specific binary requirements
const BINARIES = {
  win32: [
    { name: 'pi-server.exe', required: true, description: 'Pico backend server' },
    { name: 'pi-node/node.exe', required: true, description: 'Node.js runtime' },
  ],
  darwin: [
    { name: 'pi-server', required: true, description: 'Pico backend server', chmod: 0o755 },
    { name: 'pi-node/node', required: true, description: 'Node.js runtime', chmod: 0o755 },
  ],
  linux: [
    { name: 'pi-server', required: true, description: 'Pico backend server', chmod: 0o755 },
    { name: 'pi-node/node', required: true, description: 'Node.js runtime', chmod: 0o755 },
  ],
};

function checkBinaries() {
  const platform = process.platform;
  const required = BINARIES[platform] || [];
  const missing = [];

  console.log(`\n🔍 Checking binaries for ${platform}...\n`);

  for (const bin of required) {
    const fullPath = path.join(RESOURCES_DIR, bin.name);
    const exists = fs.existsSync(fullPath);
    const status = exists ? '✓' : '✗';
    console.log(`  ${status} ${bin.name} — ${bin.description}`);

    if (bin.required && !exists) {
      missing.push({ ...bin, path: fullPath });
    }
  }

  return { missing, platform };
}

function downloadBinary(url, destination) {
  return new Promise((resolve, reject) => {
    const dir = path.dirname(destination);
    fs.mkdirSync(dir, { recursive: true });

    const file = fs.createWriteStream(destination);
    https
      .get(url, (response) => {
        if (response.statusCode !== 200) {
          reject(new Error(`HTTP ${response.statusCode}: ${url}`));
          return;
        }
        response.pipe(file);
        file.on('finish', () => {
          file.close();
          resolve();
        });
      })
      .on('error', (err) => {
        fs.unlink(destination, () => {});
        reject(err);
      });
  });
}

async function setup() {
  const { missing, platform } = checkBinaries();

  if (missing.length === 0) {
    console.log('\n✓ All required binaries present. Ready to build.\n');
    return true;
  }

  console.log(`\n⚠️  Missing ${missing.length} binary/binaries:\n`);
  for (const bin of missing) {
    console.log(`  • ${bin.name}`);
  }

  console.log(`
📝 Setup instructions:

1. Ensure pi-server is built for your platform (${platform}):
   - pi-server is the Pico backend compiled from pico-upstream (Rust)
   - Pre-built binaries should be placed in: ${RESOURCES_DIR}/

2. Place binaries:
${missing.map((b) => `   - ${b.name} → ${b.path}`).join('\n')}

3. Alternatively, if you have a download URL for pre-built binaries:
   - Set environment variable: PI_BINARIES_URL=<download-url>
   - Run this script again to auto-download

4. Then run the build again:
   npm run build:mac     # for macOS
   npm run build:win     # for Windows

ℹ️  For development, you can also run:
   npm start            # launches the Electron dev server
   # Settings window can then manually specify pi-server path if binaries are elsewhere
`);

  process.exit(1);
}

setup().catch((err) => {
  console.error('\n❌ Setup failed:', err.message);
  process.exit(1);
});
