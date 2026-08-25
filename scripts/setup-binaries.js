#!/usr/bin/env node

/**
 * Setup script to prepare pi-server and Node binaries for packaging.
 * This must run BEFORE building the Electron app.
 *
 * pi-server: Compiled from pico-upstream (Pico backend Rust project)
 * node: Node.js portable runtime
 *
 * Dependencies: These binaries must be available before build:
 * 1. pico-upstream must be built for target platforms
 * 2. Binaries placed in resources/ OR sourced from environment
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const RESOURCES_DIR = path.join(__dirname, '..', 'resources');
const PI_NODE_DIR = path.join(RESOURCES_DIR, 'pi-node');

// Platform-specific binary requirements
const PLATFORM_BINARIES = {
  win32: [
    { name: 'pi-server.exe', required: true, from: 'pico-upstream/target/release/' },
    { name: 'pi-node/node.exe', required: false, from: 'portable-nodejs or downloaded' },
  ],
  darwin: [
    { name: 'pi-server', required: true, from: 'pico-upstream/target/release/', chmod: 0o755 },
    { name: 'pi-node/node', required: false, from: 'portable-nodejs or downloaded', chmod: 0o755 },
  ],
  linux: [
    { name: 'pi-server', required: true, from: 'pico-upstream/target/release/', chmod: 0o755 },
    { name: 'pi-node/node', required: false, from: 'portable-nodejs or downloaded', chmod: 0o755 },
  ],
};

function checkBinaries() {
  const platform = process.platform;
  const required = PLATFORM_BINARIES[platform] || [];
  const missing = [];
  const found = [];

  console.log(`\n🔍 Checking binaries for ${platform}...\n`);

  for (const bin of required) {
    const fullPath = path.join(RESOURCES_DIR, bin.name);
    const exists = fs.existsSync(fullPath);
    const status = exists ? '✓' : '✗';
    console.log(`  ${status} ${bin.name}`);

    if (exists) {
      found.push(bin);
      // Ensure executable on Unix
      if (bin.chmod && process.platform !== 'win32') {
        try {
          fs.chmodSync(fullPath, bin.chmod);
        } catch (err) {
          console.warn(`    ⚠️  Could not chmod ${bin.name}: ${err.message}`);
        }
      }
    } else if (bin.required) {
      missing.push({ ...bin, path: fullPath });
    }
  }

  return { missing, found, platform };
}

function findPicoUpstream() {
  // Look for pico-upstream in common locations relative to this repo
  const searchPaths = [
    path.join(__dirname, '..', '..', 'pico-upstream'),
    path.join(__dirname, '..', '..', 'pi-backend'),
    path.join(__dirname, '..', '..', 'backend'),
    process.env.PICO_UPSTREAM_PATH,
  ].filter(Boolean);

  for (const dir of searchPaths) {
    if (dir && fs.existsSync(path.join(dir, 'Cargo.toml'))) {
      console.log(`  Found pico-upstream at: ${dir}`);
      return dir;
    }
  }
  return null;
}

function buildPiServer(picoPath) {
  const platform = process.platform;
  const isWin = platform === 'win32';
  const binName = isWin ? 'pi-server.exe' : 'pi-server';

  console.log(`\n🔨 Building pi-server from ${picoPath}...\n`);

  try {
    // Build pi-server
    execSync('cargo build --release', { cwd: picoPath, stdio: 'inherit' });

    // Copy to resources
    const buildDir = path.join(picoPath, 'target', 'release', binName);
    const targetDir = path.join(RESOURCES_DIR, binName);

    if (fs.existsSync(buildDir)) {
      fs.mkdirSync(path.dirname(targetDir), { recursive: true });
      fs.copyFileSync(buildDir, targetDir);
      if (!isWin) fs.chmodSync(targetDir, 0o755);
      console.log(`✓ Copied pi-server to resources/`);
      return true;
    } else {
      console.error(`✗ Build succeeded but binary not found at ${buildDir}`);
      return false;
    }
  } catch (err) {
    console.error(`✗ Build failed: ${err.message}`);
    return false;
  }
}

async function setup() {
  const { missing, found, platform } = checkBinaries();

  if (missing.length === 0) {
    console.log('\n✓ All required binaries present. Ready to build.\n');
    return true;
  }

  console.log(`\n⚠️  Missing ${missing.length} binary/binaries (build will proceed but server may not start)\n`);

  // Try to auto-build from pico-upstream
  const picoPath = findPicoUpstream();
  if (picoPath) {
    console.log(`📦 Found pico-upstream, attempting to build pi-server...\n`);
    const built = buildPiServer(picoPath);
    if (built) {
      console.log('\n✓ Build succeeded. Checking again...\n');
      return setup(); // Recursively check again
    }
  }

  // If not, show manual instructions
  console.log(`📝 Setup instructions:

1. Build pico-upstream (Pico backend) for your platform:

   cd ../pico-upstream    # or wherever your pico-upstream repo is
   cargo build --release

2. Copy the binary to this project:

   cp target/release/pi-server${platform === 'win32' ? '.exe' : ''} \\
      ../expert-ai-tray/resources/

3. For node binary (optional, can use system node):

   - Copy Node.js binary to: resources/pi-node/node${platform === 'win32' ? '.exe' : ''}
   - OR: Ensure system node is in PATH

4. Then run the build:

   npm run build:${platform === 'win32' ? 'win' : 'mac'}

Environment variables:
   PICO_UPSTREAM_PATH=/path/to/pico-upstream   # If in non-standard location

ℹ️  For development (without build):
   npm start    # Launches Electron dev server
   # Settings window can manually specify pi-server path

More info: See BUILD.md in this repo
`);

  // Don't block build - just warn user
  console.log('\n⏭️  Proceeding without binaries. Server may not start until they are added.\n');
  return false;
}

setup().catch((err) => {
  console.error('\n❌ Setup failed:', err.message);
  process.exit(1);
});
