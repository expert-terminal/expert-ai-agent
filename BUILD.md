# Building Expert AI Tray Agent

## Prerequisites

- Node.js 22+ (for development)
- Electron and electron-builder (automatically installed via npm)
- **Critical**: `pico-upstream` repository (Rust Pico backend) for building `pi-server`
- Rust toolchain (if building pico-upstream locally)

## Required Binaries

The Tray Agent is a lightweight Electron wrapper around the `pi-server` backend. It requires platform-specific binaries:

### What is pi-server?

- **pi-server**: The Pico backend server (compiled from `pico-upstream`, written in Rust)
- **node**: Node.js runtime (optional — can use system `node` if available)

### Getting pi-server from pico-upstream

The setup script will **automatically detect and build** `pico-upstream` if it's in a standard location:

```
../pico-upstream/              # Sibling directory (recommended)
```

**Option 1: Automatic (recommended)**

If `pico-upstream` is in a sibling directory:

```bash
npm run build:mac        # or build:win, build:linux
# Setup script will auto-detect, build, and copy pi-server
```

**Option 2: Explicit path**

If `pico-upstream` is elsewhere:

```bash
PICO_UPSTREAM_PATH=/path/to/pico-upstream npm run build:mac
```

**Option 3: Manual**

Build pico-upstream yourself:

```bash
# In pico-upstream directory
cargo build --release

# Copy to tray repo
cp target/release/pi-server ../expert-ai-tray/resources/
# On Windows:
# cp target/release/pi-server.exe ../expert-ai-tray/resources/

# Then build tray app
cd ../expert-ai-tray
npm run build:mac
```

### Cross-platform builds

Building for other platforms requires appropriate toolchains:
- **macOS from Windows**: GitHub Actions uses `macos-latest` runner (recommended)
- **macOS cross-compile**: Requires macOS host or `cargo-osxcross`
- **Windows cross-compile**: Windows host recommended for exe signing

## Build Instructions

### 1. Install dependencies

```bash
npm install
```

### 2. Check binary setup

The setup script will verify required binaries:

```bash
npm run setup:binaries
```

This will report:
- ✓ All binaries present → ready to build
- ✗ Missing binaries → instructions on what's needed

### 3. Build for your platform

```bash
# macOS (universal binary for arm64 + x64)
npm run build:mac

# Windows (x64)
npm run build:win

# Linux
npm run build:linux
```

Built artifacts appear in `dist/`:
- **macOS**: `Expert.AI.Agent-0.1.0-arm64.dmg`, `Expert.AI.Agent-0.1.0-x64.dmg`
- **Windows**: `Expert.AI.Agent-0.1.0-x64.exe`
- **Linux**: `Expert.AI.Agent-0.1.0-amd64.AppImage`, `.deb`

## Development

For local testing without a full build:

```bash
# Start the Electron dev server
npm start

# Or with remote debugging
npm run dev
```

The app will try to locate `pi-server` in:
1. `resources/pi-server[.exe]` (packaged)
2. `./resources/pi-server[.exe]` (dev mode)

## Troubleshooting

### "pi-server exited unexpectedly"
- Check that the correct platform binary is in place
- Verify binary architecture matches (arm64 vs x64)
- On macOS: check System Preferences → Privacy & Security (may need to allow binary)

### "Port 5454 already in use"
- Another pi-server instance is running
- Close any other Expert AI Agent windows
- Click "Restart Server" in Settings

### Server won't start even after restart
- Run `npm run setup:binaries` to verify binaries are present
- Check that `node` is executable: `chmod +x resources/pi-node/node` (macOS/Linux)
- Check pi-server logs in Settings window → Pairing panel

## CI/CD

GitHub Actions builds are automated when you push a version tag:

```bash
git tag v0.2.0
git push origin v0.2.0
```

This triggers:
1. macOS builds (arm64 + x64) on `macos-latest`
2. Windows build on `windows-latest`
3. Automatic release with all artifacts

**Note**: macOS builds require macOS runners and won't work cross-compiled from Windows. The GitHub Actions workflow uses `macos-latest` to ensure proper notarization and code signing support for future releases.
