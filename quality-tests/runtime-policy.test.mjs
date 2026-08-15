import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const projects = ['.', 'backend', 'website'];

test('package and lockfile runtime policies match the pinned Node major', async () => {
  const pinnedVersion = (await readFile('.nvmrc', 'utf8')).trim();
  assert.match(pinnedVersion, /^\d+\.\d+\.\d+$/u);
  const pinnedMajor = Number(pinnedVersion.split('.')[0]);
  const expectedEngine = `>=${pinnedMajor}`;

  for (const project of projects) {
    const prefix = project === '.' ? '' : `${project}/`;
    const [manifest, lockfile] = await Promise.all([
      readFile(`${prefix}package.json`, 'utf8').then(JSON.parse),
      readFile(`${prefix}package-lock.json`, 'utf8').then(JSON.parse)
    ]);
    assert.equal(manifest.engines?.node, expectedEngine, `${prefix}package.json`);
    assert.equal(
      lockfile.packages?.['']?.engines?.node,
      expectedEngine,
      `${prefix}package-lock.json`
    );
  }

  const [productionGuide, chromeGuide] = await Promise.all([
    readFile('PRODUCTION.md', 'utf8'),
    readFile('CHROME_RELEASE.md', 'utf8')
  ]);
  assert.match(
    productionGuide,
    new RegExp(`Node\\.js ${pinnedVersion.replaceAll('.', '\\.')}\\b`, 'u')
  );
  assert.match(
    chromeGuide,
    new RegExp(`Node\\.js ${pinnedVersion.replaceAll('.', '\\.')}\\b`, 'u')
  );
});

test('backend container stages share one immutable Node 24 image and run unprivileged', async () => {
  const dockerfile = await readFile('backend/Dockerfile', 'utf8');
  const baseImages = [
    ...dockerfile.matchAll(/^FROM node:(\d+)-alpine@sha256:([a-f0-9]{64}) AS (build|runtime)$/gmu)
  ];
  assert.equal(baseImages.length, 2);
  assert.deepEqual(
    baseImages.map((match) => match[3]),
    ['build', 'runtime']
  );
  assert(baseImages.every((match) => match[1] === '24'));
  assert.equal(baseImages[0][2], baseImages[1][2]);
  assert.match(dockerfile, /^USER node$/mu);
  assert.doesNotMatch(dockerfile, /:latest\b/u);
});

test('backend Docker context excludes local secrets and development artifacts', async () => {
  const dockerignore = await readFile('backend/.dockerignore', 'utf8');
  const rules = dockerignore
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  assert.deepEqual(rules, [
    '.env',
    '.env.*',
    '!.env.example',
    'node_modules',
    'dist',
    'coverage',
    'test',
    'test*.js',
    '.git',
    '.github',
    '.DS_Store',
    '.idea',
    '.vscode',
    '*.log',
    'npm-debug.log*',
    '*.key',
    '*.pem',
    '*.p12',
    '*.pfx',
    '**/*.key',
    '**/*.pem',
    '**/*.p12',
    '**/*.pfx'
  ]);
});
