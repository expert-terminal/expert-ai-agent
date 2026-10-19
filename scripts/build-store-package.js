#!/usr/bin/env node

// Build the Microsoft Store AppX package using the identity assigned by
// Partner Center. Store packages are re-signed by Microsoft after certification;
// the EXE/NSIS build remains a separate download channel.
const path = require('node:path');
const gracefulFs = require('graceful-fs');

// Windows Defender and indexing can briefly hold a file while electron-builder
// copies the large Pi runtime and its bundled modules. Retry transient sharing
// violations instead of aborting the entire Store package build.
const originalCopyFile = gracefulFs.copyFile;
gracefulFs.copyFile = function copyFileWithWindowsRetry(...args) {
  const callback = args.pop();
  const retryableCodes = new Set(['EBUSY', 'EPERM', 'EACCES']);

  const attemptCopy = (attempt) => {
    originalCopyFile.call(this, ...args, (error) => {
      if (error && retryableCodes.has(error.code) && attempt < 12) {
        setTimeout(() => attemptCopy(attempt + 1), Math.min(250 * (attempt + 1), 1500));
        return;
      }
      callback(error);
    });
  };

  attemptCopy(0);
};

const { build, Arch, Platform } = require('electron-builder');

const required = [
  ['STORE_IDENTITY_NAME', process.env.STORE_IDENTITY_NAME],
  ['STORE_PUBLISHER', process.env.STORE_PUBLISHER],
  ['STORE_PUBLISHER_DISPLAY_NAME', process.env.STORE_PUBLISHER_DISPLAY_NAME],
];
const missing = required.filter(([, value]) => !String(value || '').trim()).map(([name]) => name);
if (missing.length) {
  console.error(`Missing Partner Center identity values: ${missing.join(', ')}`);
  console.error('Reserve the product name, then copy these exact values from its identity page.');
  process.exit(2);
}

const packageJson = require(path.resolve(__dirname, '..', 'package.json'));
const config = {
  ...packageJson.build,
  directories: {
    ...packageJson.build.directories,
    output: process.env.STORE_OUTPUT_DIR || 'dist/store',
  },
  win: {
    ...packageJson.build.win,
    target: [{ target: 'appx', arch: ['x64'] }],
  },
  appx: {
    applicationId: 'ExpertAIAgent',
    identityName: process.env.STORE_IDENTITY_NAME.trim(),
    publisher: process.env.STORE_PUBLISHER.trim(),
    publisherDisplayName: process.env.STORE_PUBLISHER_DISPLAY_NAME.trim(),
    displayName: 'Expert AI',
    backgroundColor: '#38206C',
    languages: ['en-US'],
    addAutoLaunchExtension: false,
  },
};

build({
  targets: Platform.WINDOWS.createTarget('appx', Arch.x64),
  config,
  publish: 'never',
}).catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
