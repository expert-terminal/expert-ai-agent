# Building Expert AI Tray Agent

## Prerequisites

- Node.js 22+ (for development)
- Electron and electron-builder (automatically installed via npm)
- **Critical**: Pre-built `pi-server` binaries (Pico backend)

## Required Binaries

The Tray Agent is a lightweight Electron wrapper around the `pi-server` backend. It requires platform-specific binaries:

### What is pi-server?

- **pi-server**: The Pico backend server (compiled from pico-upstream, written in Rust)
- **node**: Node.js runtime (portable version included with pi-node package)

These binaries are NOT included in the source repo — they must be provided separately.

### Where to get pi-server

**Option 1: Pre-built binaries**
If your organization has pre-built pi-server binaries:
1. Download the binaries for your target platforms (macOS arm64, macOS x64, Windows x64)
2. Place them in:
   ```
   resources/pi-server.exe          # Windows
   resources/pi-server              # macOS/Linux
   ```

**Option 2: Build from source**
If you have access to the pico-upstream repository:
```bash
# Build pi-server for your platform
cd path/to/pico-upstream
cargo build --release

# Copy the binary
cp target/release/pi-server ../expert-ai-tray/resources/
```

For cross-platform builds (e.g., building macOS binaries on Windows), you'll need:
- macOS host or cross-compilation toolchain (e.g., `cargo-osxcross`)
- Docker (for containerized cross-compilation)

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
