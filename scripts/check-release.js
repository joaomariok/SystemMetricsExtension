// Pre-publish checks for the VS Code Marketplace. Prints PASS/FAIL per check; exits 1 if any fail.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const VSCE = path.join(ROOT, 'node_modules', '@vscode', 'vsce', 'vsce');
const GALLERY = 'https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery';

function changelogHasVersion(text, version) {
  return new RegExp(`^## ${version.replace(/\./g, '\\.')}\\s*$`, 'm').test(text);
}

function publishedVersions(response) {
  const ext = response?.results?.[0]?.extensions?.[0];
  return ext ? ext.versions.map((v) => v.version) : [];
}

async function queryMarketplace(id) {
  const res = await fetch(GALLERY, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json;api-version=7.2-preview.1' },
    // filterType 7 = full extension id; flags 1 = include versions
    body: JSON.stringify({ filters: [{ criteria: [{ filterType: 7, value: id }] }], flags: 1 }),
  });
  if (!res.ok) throw new Error(`Marketplace query failed: HTTP ${res.status}`);
  return res.json();
}

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();

async function main() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const id = `${pkg.publisher}.${pkg.name}`;
  const checks = [
    ['on branch main', () => git('branch', '--show-current') === 'main'],
    ['working tree clean', () => git('status', '--porcelain') === ''],
    [
      'HEAD matches origin/main',
      () => {
        git('fetch', '--quiet', 'origin');
        return git('rev-parse', 'HEAD') === git('rev-parse', 'origin/main');
      },
    ],
    [
      `CHANGELOG.md has "## ${pkg.version}"`,
      () => changelogHasVersion(fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8'), pkg.version),
    ],
    [`tag v${pkg.version} does not exist`, () => git('tag', '--list', `v${pkg.version}`) === ''],
    [
      `${id}@${pkg.version} not yet on the Marketplace`,
      async () => !publishedVersions(await queryMarketplace(id)).includes(pkg.version),
    ],
    [
      `vsce token valid for publisher ${pkg.publisher}`,
      () => {
        execFileSync(process.execPath, [VSCE, 'verify-pat', pkg.publisher], { cwd: ROOT, stdio: 'ignore' });
        return true;
      },
    ],
  ];

  let failed = 0;
  for (const [name, check] of checks) {
    let ok = false;
    let detail = '';
    try {
      ok = await check();
    } catch (err) {
      detail = ` (${String(err.message).split('\n')[0]})`;
    }
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail}`);
    if (!ok) failed++;
  }
  process.exitCode = failed ? 1 : 0;
}

if (require.main === module) main();

module.exports = { changelogHasVersion, publishedVersions };
