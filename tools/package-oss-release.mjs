#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = resolve(new URL('..', import.meta.url).pathname);
const outRoot = resolve(repoRoot, 'dist', 'oss');
const latestDir = join(outRoot, 'latest');
const packageDir = join(outRoot, 'package');
const zipPath = join(latestDir, 'migel-desktop-connector.zip');
const requiredPaths = [
  'README.md',
  'package.json',
  'tools',
  'skills/migel-pairing',
  'desktop-connector/package.json',
  'desktop-connector/src',
  'gateway/src/server/pairingInvites.mjs',
];
const excludedDirs = new Set(['.git', 'node_modules', 'dist']);

function fail(message) {
  console.error(message);
  process.exit(1);
}

for (const path of requiredPaths) {
  if (!existsSync(join(repoRoot, path))) fail(`Missing required path: ${path}`);
}

rmSync(outRoot, { recursive: true, force: true });
mkdirSync(latestDir, { recursive: true });
mkdirSync(packageDir, { recursive: true });

for (const entry of readdirSync(repoRoot)) {
  if (excludedDirs.has(entry)) continue;
  const source = join(repoRoot, entry);
  const destination = join(packageDir, entry);
  cpSync(source, destination, {
    recursive: true,
    filter: (src) => !src.split('/').some((part) => excludedDirs.has(part)),
  });
}

copyFileSync(join(repoRoot, 'tools', 'install-and-pair.sh'), join(latestDir, 'install-and-pair.sh'));
copyFileSync(join(repoRoot, 'tools', 'install-and-pair.ps1'), join(latestDir, 'install-and-pair.ps1'));

const zip = spawnSync('zip', ['-qr', zipPath, '.'], { cwd: packageDir, encoding: 'utf8' });
if (zip.status !== 0) fail(zip.stderr || zip.stdout || 'zip command failed');

const artifacts = ['install-and-pair.sh', 'install-and-pair.ps1', 'migel-desktop-connector.zip'];
const sums = artifacts.map((name) => {
  const buffer = readFileSync(join(latestDir, name));
  const hash = createHash('sha256').update(buffer).digest('hex');
  return `${hash}  ${name}`;
});
writeFileSync(join(latestDir, 'SHA256SUMS'), `${sums.join('\n')}\n`);

let commit = null;
const git = spawnSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' });
if (git.status === 0) commit = git.stdout.trim();

writeFileSync(join(latestDir, 'version.json'), `${JSON.stringify({
  name: 'migel-desktop-connector',
  channel: 'latest',
  commit,
  generatedAt: new Date().toISOString(),
  files: Object.fromEntries(artifacts.map((name) => [name, {
    sha256: sums.find((line) => line.endsWith(`  ${name}`)).split('  ')[0],
    bytes: statSync(join(latestDir, name)).size,
  }])),
}, null, 2)}\n`);

console.log(`OSS package written to ${latestDir}`);
for (const name of [...artifacts, 'SHA256SUMS', 'version.json']) {
  console.log(`- ${name}`);
}
