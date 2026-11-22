// Tiny JSON config store — no extra dependency needed for a handful of settings.
const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

const DEFAULTS = {
  pairing: null,       // { code } — the relay pairing code, generated locally on first run
  session: null,        // this desktop's OWN gateway session (device-login flow, see auth.js)
  // The MAS build's container cannot access Documents until the user selects
  // a folder in the system picker. Start inside userData there; direct builds
  // keep the existing Documents default.
  workdir: process.mas ? app.getPath('userData') : app.getPath('documents'),
  autoRun: true,        // matches the "auto-run, no confirm prompts" default agreed for v1
  // Starting on login is opt-in. This keeps first-run behavior transparent and
  // gives Store users control over background startup; the tray Settings screen
  // can enable it when they want the computer available automatically.
  autoStart: false,
  hasCompletedSetup: false, // drives the first-run wizard vs. the compact dashboard
};

class Store {
  constructor() {
    this.file = path.join(app.getPath('userData'), 'config.json');
    this.data = this._load();
  }

  _load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf-8');
      return { ...DEFAULTS, ...JSON.parse(raw) };
    } catch {
      return { ...DEFAULTS };
    }
  }

  _save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf-8');
  }

  get(key) {
    return this.data[key];
  }

  set(key, value) {
    this.data[key] = value;
    this._save();
  }

  all() {
    return { ...this.data };
  }
}

module.exports = { Store };
