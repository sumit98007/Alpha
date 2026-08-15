import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  buildProductionManifest,
  ICON_PATHS,
  normalizeOAuthEndpoint,
  normalizeProductionApiOrigin,
  normalizeReleaseConfiguration,
  SUPPORTED_PAGE_PATTERNS
} from '../scripts/extension-manifest-policy.mjs';

const manifestPath = path.resolve('extension/manifest.json');
const VERIFY_CONFIGURATION = Object.freeze({
  apiOrigin: 'https://api.alpha.example',
  authorizationEndpoint: 'https://login.alpha.example/oauth2/authorize',
  tokenEndpoint: 'https://tokens.alpha.example/oauth2/token',
  oauthClientId: 'alpha-extension-client.example',
  oauthScopes: 'openid alpha.api.example'
});

test('production manifest host access contains only the fixed API and token origins', async () => {
  const developmentManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.deepEqual(
    new Set(developmentManifest.host_permissions),
    new Set(['https://api.alpha.invalid/*', 'https://auth.alpha.invalid/*'])
  );
  const productionManifest = buildProductionManifest(developmentManifest, VERIFY_CONFIGURATION, {
    allowReserved: true
  });

  assert.equal(productionManifest.manifest_version, 3);
  assert.equal(productionManifest.options_ui, undefined);
  assert.equal(productionManifest.optional_host_permissions, undefined);
  assert.deepEqual(productionManifest.icons, ICON_PATHS);
  assert.deepEqual(productionManifest.action.default_icon, ICON_PATHS);
  assert(productionManifest.permissions.includes('identity'));
  assert.deepEqual(
    new Set(productionManifest.host_permissions),
    new Set(['https://api.alpha.example/*', 'https://tokens.alpha.example/*'])
  );
  assert(!productionManifest.host_permissions.includes('https://login.alpha.example/*'));
  assert(!productionManifest.host_permissions.some((value) => value.startsWith('http://')));
  assert(!productionManifest.host_permissions.includes('https://*/*'));
  assert.deepEqual(
    new Set(productionManifest.content_scripts[0].matches),
    new Set(SUPPORTED_PAGE_PATTERNS)
  );
  assert.deepEqual(productionManifest.web_accessible_resources, [
    {
      resources: ['floating-frame.html'],
      matches: [...SUPPORTED_PAGE_PATTERNS]
    }
  ]);
});

test('production API origin must be exact, HTTPS, and non-local', () => {
  const invalidValues = [
    '',
    'http://api.alpha.example',
    'http://localhost:3000',
    'https://localhost.',
    'https://127.0.0.1',
    'https://10.0.0.1',
    'https://[::1]',
    'https://api.alpha.local',
    'https://api.example.com',
    'https://*.alpha.example',
    'https://user:pass@api.alpha.example',
    'https://api.alpha.example/v1',
    'not a URL'
  ];

  for (const value of invalidValues) {
    assert.throws(() => normalizeProductionApiOrigin(value), undefined, value);
  }
  assert.throws(() => normalizeProductionApiOrigin('https://api.alpha.example'), /Reserved/);
  assert.equal(
    normalizeProductionApiOrigin('https://api.alpha.example', { allowReserved: true }),
    'https://api.alpha.example'
  );
});

test('OAuth endpoints must be exact, HTTPS, non-local provider URLs', () => {
  const invalidValues = [
    '',
    'http://identity.alpha.com/oauth2/authorize',
    'https://localhost/oauth2/authorize',
    'https://localhost./oauth2/authorize',
    'https://127.0.0.1/oauth2/authorize',
    'https://[::1]/oauth2/authorize',
    'https://*.alpha.com/oauth2/authorize',
    'https://user:pass@identity.alpha.com/oauth2/authorize',
    'https://identity.alpha.com',
    'https://identity.alpha.com/oauth2/authorize?audience=alpha',
    'https://identity.alpha.com/oauth2/authorize#fragment',
    'https://identity.example.com/oauth2/authorize',
    'not a URL'
  ];

  for (const value of invalidValues) {
    assert.throws(
      () => normalizeOAuthEndpoint(value, 'OAuth authorization endpoint'),
      undefined,
      value
    );
  }
  assert.throws(
    () =>
      normalizeOAuthEndpoint('https://identity.alpha.example/oauth2/authorize', 'OAuth endpoint'),
    /Reserved/
  );
  assert.equal(
    normalizeOAuthEndpoint('https://identity.alpha.example/oauth2/authorize', 'OAuth endpoint', {
      allowReserved: true
    }),
    'https://identity.alpha.example/oauth2/authorize'
  );
  assert.throws(
    () =>
      normalizeOAuthEndpoint('https://auth.alpha.invalid/oauth2/authorize', 'OAuth endpoint', {
        allowReserved: true
      }),
    /cannot be packaged/
  );
});

test('release configuration rejects unresolved OAuth client and scope placeholders', () => {
  assert.throws(
    () =>
      normalizeReleaseConfiguration(
        { ...VERIFY_CONFIGURATION, oauthClientId: 'alpha-extension-client.invalid' },
        { allowReserved: true }
      ),
    /placeholder OAuth client ID/
  );
  assert.throws(
    () =>
      normalizeReleaseConfiguration(
        {
          ...VERIFY_CONFIGURATION,
          oauthScopes: 'openid alpha.api.invalid'
        },
        { allowReserved: true }
      ),
    /placeholder OAuth scope/
  );
  assert.throws(
    () =>
      normalizeReleaseConfiguration(
        { ...VERIFY_CONFIGURATION, oauthScopes: 'openid alpha.api.example offline_access' },
        { allowReserved: true }
      ),
    /offline_access/
  );
  assert.throws(
    () =>
      normalizeReleaseConfiguration(
        { ...VERIFY_CONFIGURATION, oauthScopes: 'openid alpha.api.example scope\\injection' },
        { allowReserved: true }
      ),
    /runtime scope grammar/
  );
  assert.throws(
    () =>
      normalizeReleaseConfiguration(
        { ...VERIFY_CONFIGURATION, oauthClientId: 'x'.repeat(257) },
        { allowReserved: true }
      ),
    /printable, space-free/
  );
  assert.throws(() => normalizeReleaseConfiguration(VERIFY_CONFIGURATION), /Reserved/);
  assert.deepEqual(
    normalizeReleaseConfiguration(VERIFY_CONFIGURATION, { allowReserved: true }),
    VERIFY_CONFIGURATION
  );
  const productionConfiguration = {
    apiOrigin: 'https://api.alpha.com',
    authorizationEndpoint: 'https://login.alpha.com/oauth2/authorize',
    tokenEndpoint: 'https://tokens.alpha.com/oauth2/token',
    oauthClientId: 'alpha-extension-production-client',
    oauthScopes: 'openid alpha.api'
  };
  assert.deepEqual(normalizeReleaseConfiguration(productionConfiguration), productionConfiguration);
});

test('unreviewed Chrome permissions fail the production build', async () => {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.permissions.push('tabs');

  assert.throws(
    () => buildProductionManifest(manifest, VERIFY_CONFIGURATION, { allowReserved: true }),
    /permissions must exactly match the reviewed production value/u
  );
});

test('source manifest rejects unreviewed top-level and nested execution surfaces', async () => {
  const source = JSON.parse(await readFile(manifestPath, 'utf8'));
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
      label: 'module background worker',
      mutate: (manifest) => {
        manifest.background.type = 'module';
      },
      expected: /background.*unreviewed fields: type/iu
    },
    {
      label: 'changed content stack',
      mutate: (manifest) => {
        manifest.content_scripts[0].js.push('modules/unreviewed.js');
      },
      expected: /content script stack must exactly match/iu
    },
    {
      label: 'changed popup',
      mutate: (manifest) => {
        manifest.action.default_popup = 'privacy.html';
      },
      expected: /action popup and title must match/iu
    },
    {
      label: 'expanded WAR group',
      mutate: (manifest) => {
        manifest.web_accessible_resources[0].use_dynamic_url = true;
      },
      expected: /web-accessible resource group.*unreviewed fields: use_dynamic_url/iu
    }
  ];

  for (const testCase of cases) {
    const tampered = structuredClone(source);
    testCase.mutate(tampered);
    assert.throws(
      () => buildProductionManifest(tampered, VERIFY_CONFIGURATION, { allowReserved: true }),
      testCase.expected,
      testCase.label
    );
  }
});
