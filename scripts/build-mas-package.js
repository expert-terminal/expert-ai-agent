#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { build, Arch, Platform } = require('electron-builder');

const root = path.resolve(__dirname, '..');
const packageJson = require(path.join(root, 'package.json'));
const profile = process.env.MAS_PROVISIONING_PROFILE;
const buildVersion = process.env.MACOS_BUILD_VERSION;
const copyright = process.env.MACOS_COPYRIGHT;

const missing = [
  ['MAS_PROVISIONING_PROFILE', profile],
  ['MACOS_BUILD_VERSION', buildVersion],
  ['MACOS_COPYRIGHT', copyright],
].filter(([, value]) => !String(value || '').trim()).map(([name]) => name);

if (missing.length) {
  console.error(`Missing Mac App Store build settings: ${missing.join(', ')}`);
  process.exit(2);
}

if (!fs.existsSync(profile)) {
  console.error('The Mac App Store provisioning profile file is missing.');
  process.exit(2);
}

if (!/^\d+(\.\d+){0,2}$/.test(buildVersion)) {
  console.error('MACOS_BUILD_VERSION must be one to three dot-separated integers.');
  process.exit(2);
}

const config = {
  ...packageJson.build,
  buildVersion,
  artifactName: '${productName}-${version}-mas-${arch}.${ext}',
  directories: {
    ...packageJson.build.directories,
    output: process.env.MAS_OUTPUT_DIR || 'dist/mas',
  },
  mac: {
    ...packageJson.build.mac,
    target: [{ target: 'mas', arch: ['universal'] }],
    extendInfo: {
      ...packageJson.build.mac.extendInfo,
      NSHumanReadableCopyright: copyright,
    },
  },
  mas: {
    provisioningProfile: profile,
    entitlements: 'build/entitlements.mas.plist',
    entitlementsInherit: 'build/entitlements.mas.inherit.plist',
    forceCodeSigning: true,
  },
};

build({
  targets: Platform.MAC.createTarget('mas', Arch.universal),
  config,
  publish: 'never',
}).catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
