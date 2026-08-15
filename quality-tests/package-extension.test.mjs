import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import { createExtensionPackage, parsePackageArguments } from '../scripts/package-extension.mjs';
import { createDeterministicZip, readDeterministicZip } from '../scripts/lib/deterministic-zip.mjs';
import {
  BACKGROUND_IMPORT_FILES,
  createReviewedConfigSource,
  parseVerifierArguments,
  REVIEWED_ARCHIVE_FILES,
  verifyExtensionArchive
} from '../scripts/verify-extension-package.mjs';

const VERIFY_CONFIGURATION = Object.freeze({
  apiOrigin: 'https://api.alpha.example',
  authorizationEndpoint: 'https://login.alpha.example/oauth2/authorize',
  tokenEndpoint: 'https://tokens.alpha.example/oauth2/token',
  oauthClientId: 'alpha-extension-client.example',
  oauthScopes: 'openid alpha.api.example'
});

function rewriteArchive(archive, rewrite) {
  return createDeterministicZip(
    [...readDeterministicZip(archive)].map(([name, data]) => ({
      name,
      data: rewrite(name, data)
    }))
  );
}

function withoutArchiveEntry(archive, removedName) {
  return createDeterministicZip(
    [...readDeterministicZip(archive)]
      .filter(([name]) => name !== removedName)
      .map(([name, data]) => ({ name, data }))
  );
}

function withArchiveEntry(archive, name, data = 'unreviewed') {
  return createDeterministicZip([
    ...[...readDeterministicZip(archive)].map(([entryName, entryData]) => ({
      name: entryName,
      data: entryData
    })),
    { name, data: Buffer.from(data, 'utf8') }
  ]);
}

function rewriteManifestArchive(archive, mutate) {
  return rewriteArchive(archive, (name, data) => {
    if (name !== 'manifest.json') return data;
    const manifest = JSON.parse(data.toString('utf8'));
    mutate(manifest);
    return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  });
}

test('Chrome package is reproducible and contains only reviewed runtime files', async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'alpha-package-test-'));
  const firstPath = path.join(temporaryDirectory, 'first.zip');
  const secondPath = path.join(temporaryDirectory, 'second.zip');

  const first = await createExtensionPackage({
    ...VERIFY_CONFIGURATION,
    outputPath: firstPath,
    verifyOnly: true
  });
  const second = await createExtensionPackage({
    ...VERIFY_CONFIGURATION,
    outputPath: secondPath,
    verifyOnly: true
  });

  assert.equal(first.sha256, second.sha256);
  assert((await readFile(firstPath)).equals(await readFile(secondPath)));

  const entries = readDeterministicZip(first.archive);
  assert.deepEqual([...entries.keys()].sort(), REVIEWED_ARCHIVE_FILES);
  assert(entries.has('manifest.json'));
  assert(!entries.has('options.html'));
  assert(!entries.has('options.js'));
  assert(!entries.has('.env'));
  assert(![...entries.keys()].some((name) => name.endsWith('.map')));

  const packagedManifest = JSON.parse(entries.get('manifest.json').toString('utf8'));
  assert.equal(
    entries.get('modules/config.js').toString('utf8'),
    createReviewedConfigSource(first.configuration)
  );
  assert.deepEqual(
    new Set(packagedManifest.host_permissions),
    new Set([`${VERIFY_CONFIGURATION.apiOrigin}/*`, 'https://tokens.alpha.example/*'])
  );
  assert(!packagedManifest.host_permissions.includes('https://login.alpha.example/*'));
  assert(packagedManifest.permissions.includes('identity'));
  assert.equal(packagedManifest.options_ui, undefined);
  assert.equal(packagedManifest.optional_host_permissions, undefined);

  const runtimeText = [...entries]
    .filter(([name]) => /\.(?:html|js)$/i.test(name))
    .map(([, data]) => data.toString('utf8'))
    .join('\n');
  for (const value of Object.values(VERIFY_CONFIGURATION)) {
    assert(runtimeText.includes(value), value);
  }
  for (const placeholder of [
    'https://api.alpha.invalid',
    'https://auth.alpha.invalid/oauth2/authorize',
    'https://auth.alpha.invalid/oauth2/token',
    'alpha-extension-client.invalid',
    'openid alpha.api.invalid'
  ]) {
    assert(!runtimeText.includes(placeholder), placeholder);
  }
});

test('package and verifier CLIs accept the complete fixed OAuth configuration', () => {
  const argumentsList = [
    'artifacts/alpha-extension-ci.zip',
    `--api-origin=${VERIFY_CONFIGURATION.apiOrigin}`,
    `--oauth-authorization-endpoint=${VERIFY_CONFIGURATION.authorizationEndpoint}`,
    `--oauth-token-endpoint=${VERIFY_CONFIGURATION.tokenEndpoint}`,
    `--oauth-client-id=${VERIFY_CONFIGURATION.oauthClientId}`,
    `--oauth-scopes=${VERIFY_CONFIGURATION.oauthScopes}`,
    '--output=artifacts/ignored-by-verifier.zip',
    '--verify-only'
  ];
  const packageOptions = parsePackageArguments(argumentsList.slice(1), {});
  assert.deepEqual(
    {
      apiOrigin: packageOptions.apiOrigin,
      authorizationEndpoint: packageOptions.authorizationEndpoint,
      oauthClientId: packageOptions.oauthClientId,
      oauthScopes: packageOptions.oauthScopes,
      tokenEndpoint: packageOptions.tokenEndpoint,
      verifyOnly: packageOptions.verifyOnly
    },
    { ...VERIFY_CONFIGURATION, verifyOnly: true }
  );

  const verifierOptions = parseVerifierArguments(
    argumentsList.filter((argument) => !argument.startsWith('--output=')),
    {}
  );
  assert.deepEqual(
    {
      apiOrigin: verifierOptions.apiOrigin,
      archivePath: verifierOptions.archivePath,
      authorizationEndpoint: verifierOptions.authorizationEndpoint,
      oauthClientId: verifierOptions.oauthClientId,
      oauthScopes: verifierOptions.oauthScopes,
      tokenEndpoint: verifierOptions.tokenEndpoint,
      verifyOnly: verifierOptions.verifyOnly
    },
    {
      ...VERIFY_CONFIGURATION,
      archivePath: 'artifacts/alpha-extension-ci.zip',
      verifyOnly: true
    }
  );
});

test('independent verifier rejects unresolved or mismatched embedded OAuth configuration', async () => {
  const result = await createExtensionPackage({
    ...VERIFY_CONFIGURATION,
    verifyOnly: true
  });
  const unresolved = rewriteArchive(result.archive, (name, data) => {
    if (!name.endsWith('.js')) return data;
    return Buffer.from(
      data
        .toString('utf8')
        .replaceAll(
          VERIFY_CONFIGURATION.authorizationEndpoint,
          'https://auth.alpha.invalid/oauth2/authorize'
        ),
      'utf8'
    );
  });
  assert.throws(
    () => verifyExtensionArchive(unresolved, VERIFY_CONFIGURATION, { allowReserved: true }),
    /unresolved OAuth provider endpoint/
  );

  const mismatched = rewriteArchive(result.archive, (name, data) => {
    if (!name.endsWith('.js')) return data;
    return Buffer.from(
      data
        .toString('utf8')
        .replaceAll(VERIFY_CONFIGURATION.oauthClientId, 'different-client.example'),
      'utf8'
    );
  });
  assert.throws(
    () => verifyExtensionArchive(mismatched, VERIFY_CONFIGURATION, { allowReserved: true }),
    /does not byte-match the reviewed active configuration template/u
  );
});

test('config attestation rejects active-value tampering hidden by expected dead literals', async () => {
  const result = await createExtensionPackage({
    ...VERIFY_CONFIGURATION,
    verifyOnly: true
  });
  const cases = [
    ['API_ORIGIN', VERIFY_CONFIGURATION.apiOrigin, 'https://attacker.example.net'],
    [
      'OAUTH_AUTHORIZATION_ENDPOINT',
      VERIFY_CONFIGURATION.authorizationEndpoint,
      'https://attacker.example.net/oauth/authorize'
    ],
    [
      'OAUTH_TOKEN_ENDPOINT',
      VERIFY_CONFIGURATION.tokenEndpoint,
      'https://attacker.example.net/oauth/token'
    ],
    ['OAUTH_CLIENT_ID', VERIFY_CONFIGURATION.oauthClientId, 'attacker-public-client'],
    ['OAUTH_SCOPES', VERIFY_CONFIGURATION.oauthScopes, 'openid attacker.api']
  ];

  for (const [field, expectedValue, attackerValue] of cases) {
    const tampered = rewriteArchive(result.archive, (name, data) => {
      if (name !== 'modules/config.js') return data;
      const expectedAssignment = `${field}: ${JSON.stringify(expectedValue)}`;
      const attackerAssignment = `${field}: ${JSON.stringify(attackerValue)}`;
      const source = data.toString('utf8').replace(expectedAssignment, attackerAssignment);
      assert.notEqual(source, data.toString('utf8'), field);
      return Buffer.from(`${source}// retained decoy ${JSON.stringify(expectedValue)}\n`, 'utf8');
    });
    const tamperedConfig = readDeterministicZip(tampered).get('modules/config.js').toString('utf8');
    assert(tamperedConfig.includes(JSON.stringify(expectedValue)), field);
    assert(tamperedConfig.includes(JSON.stringify(attackerValue)), field);
    assert.throws(
      () => verifyExtensionArchive(tampered, VERIFY_CONFIGURATION, { allowReserved: true }),
      /does not byte-match the reviewed active configuration template/u,
      field
    );
  }
});

test('independent verifier rejects missing secure-frame HTML dependencies', async () => {
  const result = await createExtensionPackage({
    ...VERIFY_CONFIGURATION,
    verifyOnly: true
  });
  for (const missingName of ['floating-frame.js', 'styles.css']) {
    assert.throws(
      () =>
        verifyExtensionArchive(
          withoutArchiveEntry(result.archive, missingName),
          VERIFY_CONFIGURATION,
          { allowReserved: true }
        ),
      /Production archive is missing reviewed files/,
      missingName
    );
  }
});

test('independent verifier requires every literal service-worker dependency', async () => {
  const result = await createExtensionPackage({
    ...VERIFY_CONFIGURATION,
    verifyOnly: true
  });
  const entries = readDeterministicZip(result.archive);
  const backgroundSource = entries.get('background.js').toString('utf8');
  for (const dependency of BACKGROUND_IMPORT_FILES) {
    assert.match(backgroundSource, new RegExp(`['"]${dependency.replaceAll('.', '\\.')}['"]`));
    assert.throws(
      () =>
        verifyExtensionArchive(
          withoutArchiveEntry(result.archive, dependency),
          VERIFY_CONFIGURATION,
          { allowReserved: true }
        ),
      /Production archive is missing reviewed files/,
      dependency
    );
  }

  const changedImportStack = rewriteArchive(result.archive, (name, data) =>
    name === 'background.js'
      ? Buffer.from(data.toString('utf8').replace("  'modules/auth.js'\n", ''), 'utf8')
      : data
  );
  assert.throws(
    () => verifyExtensionArchive(changedImportStack, VERIFY_CONFIGURATION, { allowReserved: true }),
    /importScripts dependencies must exactly match the reviewed stack/u
  );
});

test('independent verifier enforces the exact reviewed archive inventory', async () => {
  const result = await createExtensionPackage({
    ...VERIFY_CONFIGURATION,
    verifyOnly: true
  });
  assert.throws(
    () =>
      verifyExtensionArchive(
        withoutArchiveEntry(result.archive, 'privacy.html'),
        VERIFY_CONFIGURATION,
        { allowReserved: true }
      ),
    /missing reviewed files: privacy\.html/u
  );
  assert.throws(
    () =>
      verifyExtensionArchive(
        withArchiveEntry(result.archive, 'modules/unreviewed.js'),
        VERIFY_CONFIGURATION,
        { allowReserved: true }
      ),
    /contains unreviewed files: modules\/unreviewed\.js/u
  );
});

test('independent verifier rejects manifest execution-surface tampering', async () => {
  const result = await createExtensionPackage({
    ...VERIFY_CONFIGURATION,
    verifyOnly: true
  });
  const cases = [
    {
      label: 'MAIN-world content script',
      mutate: (manifest) => {
        manifest.content_scripts[0].world = 'MAIN';
      },
      expected: /content script.*unreviewed fields: world/iu
    },
    {
      label: 'all-frame content script',
      mutate: (manifest) => {
        manifest.content_scripts[0].all_frames = true;
      },
      expected: /content script.*unreviewed fields: all_frames/iu
    },
    {
      label: 'externally connectable surface',
      mutate: (manifest) => {
        manifest.externally_connectable = { matches: ['https://evil.example/*'] };
      },
      expected: /top level.*unreviewed fields: externally_connectable/iu
    },
    {
      label: 'weakened CSP',
      mutate: (manifest) => {
        manifest.content_security_policy.extension_pages =
          "script-src 'self' 'unsafe-eval'; object-src 'none'";
      },
      expected: /extension CSP must exactly match/iu
    },
    {
      label: 'changed worker',
      mutate: (manifest) => {
        manifest.background.service_worker = 'floating-frame.js';
      },
      expected: /reviewed classic background\.js worker/iu
    },
    {
      label: 'changed content stack',
      mutate: (manifest) => {
        manifest.content_scripts[0].js.push('floating-frame.js');
      },
      expected: /content script stack must exactly match/iu
    },
    {
      label: 'changed popup',
      mutate: (manifest) => {
        manifest.action.default_popup = 'privacy.html';
      },
      expected: /action popup and title must match/iu
    }
  ];

  for (const testCase of cases) {
    const tampered = rewriteManifestArchive(result.archive, testCase.mutate);
    assert.throws(
      () => verifyExtensionArchive(tampered, VERIFY_CONFIGURATION, { allowReserved: true }),
      testCase.expected,
      testCase.label
    );
  }
});

test('build configuration is serialized as a whole literal and cannot inject JavaScript', async () => {
  const hostileClientId = String.raw`client',INJECTED:(globalThis.oauthInjected=true),TRAIL:"\\",REST:'rest`;
  const result = await createExtensionPackage({
    ...VERIFY_CONFIGURATION,
    oauthClientId: hostileClientId,
    verifyOnly: true
  });
  const entries = readDeterministicZip(result.archive);
  const configSource = entries.get('modules/config.js').toString('utf8');
  assert(configSource.includes(JSON.stringify(hostileClientId)));

  const sandbox = {};
  sandbox.globalThis = sandbox;
  vm.runInNewContext(configSource, sandbox, { filename: 'modules/config.js' });
  assert.equal(sandbox.oauthInjected, undefined);
  assert.equal(sandbox.AlphaConfig.OAUTH_CLIENT_ID, hostileClientId);
  assert.equal(Object.hasOwn(sandbox.AlphaConfig, 'INJECTED'), false);
});
