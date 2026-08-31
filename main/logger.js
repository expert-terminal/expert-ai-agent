// Persistent error/diagnostic logging — a tray app has no visible terminal, so
// without this, a crash or silent failure leaves nothing for a non-technical user
// to hand you when something goes wrong beyond "it doesn't work." Writes to a
// single rotating file under userData/logs/app.log, cross-platform (uses
// app.getPath('userData'), same path electron-builder installs already rely on
// for config/session storage on both Windows and macOS).
const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

const MAX_LOG_BYTES = 2 * 1024 * 1024; // 2MB — plenty for diagnosing a recent issue, small enough to paste/attach

let logFile = null;

function initLogger() {
  const dir = path.join(app.getPath('userData'), 'logs');
  fs.mkdirSync(dir, { recursive: true });
  logFile = path.join(dir, 'app.log');

  // Simple rotation: if it's grown past the cap, keep only the most recent half
  // instead of letting it grow unbounded across months of runtime.
  try {
    const stat = fs.existsSync(logFile) ? fs.statSync(logFile) : null;
    if (stat && stat.size > MAX_LOG_BYTES) {
      const content = fs.readFileSync(logFile, 'utf-8');
      fs.writeFileSync(logFile, content.slice(-Math.floor(MAX_LOG_BYTES / 2)));
    }
  } catch {
    // Non-fatal — logging should never be able to crash the app it's diagnosing.
  }

  log('INFO', `--- Expert AI Agent starting (v${app.getVersion()}, ${process.platform}) ---`);

  // These would otherwise crash the process with nothing recorded anywhere —
  // exactly the kind of failure a non-technical user can't describe to you beyond
  // "it just closed." Log first, then let Electron's own default handling proceed
  // (for uncaughtException specifically, the process may still exit after this —
  // that's fine, the point is getting the reason on disk before it does).
  process.on('uncaughtException', (err) => {
    log('ERROR', 'uncaughtException:', err?.stack || err?.message || String(err));
  });
  process.on('unhandledRejection', (reason) => {
    log('ERROR', 'unhandledRejection:', reason?.stack || reason?.message || String(reason));
  });

  return logFile;
}

function log(level, ...args) {
  const line = `[${new Date().toISOString()}] [${level}] ${args
    .map((a) => (typeof a === 'string' ? a : safeStringify(a)))
    .join(' ')}\n`;
  try {
    if (logFile) fs.appendFileSync(logFile, line);
  } catch {
    // If the log file itself can't be written, there's nothing more to do —
    // don't let logging failures cascade into another uncaught exception.
  }
}

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function getLogFile() {
  return logFile;
}

function readLogTail(maxChars = 20000) {
  try {
    const content = fs.readFileSync(logFile, 'utf-8');
    return content.length > maxChars ? content.slice(-maxChars) : content;
  } catch {
    return '';
  }
}

module.exports = { initLogger, log, getLogFile, readLogTail };
