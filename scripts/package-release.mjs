// Packages a Marketplace release whose `sattest.backendUrl` defaults to the
// hosted backend, while the repo itself keeps `http://localhost:3000`.
//
// The hosted URL is read from the environment, so it never appears in this
// repo — not in package.json and not in this script:
//
//   SATTEST_RELEASE_BACKEND_URL=https://… npm run package:release
//
// Extra arguments are passed through to `vsce package`, e.g.
//   npm run package:release -- --pre-release
//
// package.json is restored afterwards, even if packaging fails, so a release
// build can't leave the hosted URL behind to be committed by accident.

import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const PACKAGE_JSON = new URL('../package.json', import.meta.url);
const LOCAL_DEFAULT = '"default": "http://localhost:3000"';

const releaseUrl = process.env.SATTEST_RELEASE_BACKEND_URL?.trim();
if (!releaseUrl) {
  fail('Set SATTEST_RELEASE_BACKEND_URL to the hosted backend URL.');
}

let parsed;
try {
  parsed = new URL(releaseUrl);
} catch {
  fail(`SATTEST_RELEASE_BACKEND_URL is not a valid URL: ${releaseUrl}`);
}
// The extension refuses non-TLS backends outside localhost, and a release that
// defaults to localhost would ship an extension that can't reach anything.
if (parsed.protocol !== 'https:' || ['localhost', '127.0.0.1'].includes(parsed.hostname)) {
  fail('SATTEST_RELEASE_BACKEND_URL must be an https:// URL that is not localhost.');
}
// Match how the setting is used: a base URL with no trailing slash or path.
const releaseDefault = `"default": ${JSON.stringify(parsed.origin)}`;

const original = readFileSync(PACKAGE_JSON, 'utf8');
const occurrences = original.split(LOCAL_DEFAULT).length - 1;
if (occurrences !== 1) {
  fail(
    `Expected exactly one ${LOCAL_DEFAULT} in package.json, found ${occurrences}. ` +
      'Update LOCAL_DEFAULT in this script if the setting changed.'
  );
}

const restore = () => writeFileSync(PACKAGE_JSON, original);
// Ctrl-C during packaging must not leave the hosted URL in package.json.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    restore();
    process.exit(130);
  });
}

let status;
try {
  writeFileSync(PACKAGE_JSON, original.replace(LOCAL_DEFAULT, releaseDefault));
  console.log(`Packaging with sattest.backendUrl default → ${parsed.origin}`);
  const result = spawnSync(
    'npx',
    ['--yes', '@vscode/vsce@3', 'package', ...process.argv.slice(2)],
    { stdio: 'inherit', shell: process.platform === 'win32' }
  );
  status = result.status ?? 1;
} finally {
  restore();
}

if (readFileSync(PACKAGE_JSON, 'utf8') !== original) {
  fail('package.json was not restored — check it before committing!');
}
console.log('package.json restored to the localhost default.');
process.exit(status);

function fail(message) {
  console.error(`package:release: ${message}`);
  process.exit(1);
}
