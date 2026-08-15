import { isIP } from 'node:net';

export const ICON_PATHS = Object.freeze({
  16: 'assets/icons/icon-16.png',
  32: 'assets/icons/icon-32.png',
  48: 'assets/icons/icon-48.png',
  128: 'assets/icons/icon-128.png'
});

export const SUPPORTED_PAGE_PATTERNS = Object.freeze([
  'https://chatgpt.com/*',
  'https://claude.ai/*',
  'https://gemini.google.com/*'
]);

const DEVELOPMENT_API_PATTERN = 'https://api.alpha.invalid/*';
const DEVELOPMENT_OAUTH_PATTERN = 'https://auth.alpha.invalid/*';
const DEVELOPMENT_HOSTS = new Set([DEVELOPMENT_API_PATTERN, DEVELOPMENT_OAUTH_PATTERN]);
const ALLOWED_PERMISSIONS = new Set(['identity', 'storage']);
const PLACEHOLDER_CLIENT_ID = 'alpha-extension-client.invalid';
const PLACEHOLDER_SCOPES = 'openid alpha.api.invalid';
const TOP_LEVEL_MANIFEST_KEYS = Object.freeze([
  'manifest_version',
  'name',
  'version',
  'minimum_chrome_version',
  'description',
  'icons',
  'permissions',
  'host_permissions',
  'background',
  'content_scripts',
  'action',
  'content_security_policy',
  'web_accessible_resources'
]);
const CONTENT_SCRIPT_FILES = Object.freeze([
  'modules/runtime.js',
  'modules/platform-adapters.js',
  'modules/frame-protocol.js',
  'modules/content-observer.js',
  'modules/floating-ui.js',
  'content.js'
]);
const DEVELOPMENT_ACTION_ICONS = Object.freeze({
  16: ICON_PATHS[16],
  32: ICON_PATHS[32]
});
const EXTENSION_CSP = "script-src 'self'; object-src 'none'";
const EXTENSION_NAME = 'Alpha - Secure Prompt Optimizer';
const EXTENSION_DESCRIPTION =
  'Turns rough ideas into professional prompts while redacting recognised sensitive-value patterns locally.';
const ACTION_TITLE = 'Alpha Prompt Optimizer';

function uniqueSorted(values) {
  return [...new Set(values)].sort();
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertExactKeys(value, expectedKeys, label) {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  const expected = new Set(expectedKeys);
  const actual = Object.keys(value);
  const unexpected = actual.filter((key) => !expected.has(key));
  const missing = expectedKeys.filter((key) => !Object.hasOwn(value, key));
  if (unexpected.length || missing.length) {
    const details = [
      unexpected.length ? `unreviewed fields: ${unexpected.join(', ')}` : '',
      missing.length ? `missing fields: ${missing.join(', ')}` : ''
    ]
      .filter(Boolean)
      .join('; ');
    throw new Error(`${label} has an unapproved shape (${details}).`);
  }
}

function assertExactJson(value, expected, label) {
  if (JSON.stringify(value) !== JSON.stringify(expected)) {
    throw new Error(`${label} must exactly match the reviewed production value.`);
  }
}

export function normalizeProductionApiOrigin(value, { allowReserved = false } = {}) {
  if (!value || typeof value !== 'string') {
    throw new Error('Set ALPHA_API_ORIGIN or pass --api-origin=https://api.your-domain.com.');
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('The production API origin must be a valid absolute HTTPS URL.');
  }

  if (parsed.protocol !== 'https:') {
    throw new Error('The production API origin must use HTTPS.');
  }
  if (parsed.username || parsed.password) {
    throw new Error('The production API origin cannot contain credentials.');
  }
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error(
      'The production API value must be an origin without a path, query, or fragment.'
    );
  }

  validateExactHostname(parsed.hostname, 'production API origin', { allowReserved });

  return parsed.origin;
}

function validateExactHostname(hostnameValue, label, { allowReserved = false } = {}) {
  const hostname = hostnameValue.toLowerCase().replace(/\.$/, '');
  const unwrappedHostname = hostname.replace(/^\[|\]$/g, '');
  const isLocal =
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    isIP(unwrappedHostname) !== 0;
  if (isLocal || hostname.includes('*')) {
    throw new Error(`The ${label} must name one exact, non-local host.`);
  }

  const usesDocumentationDomain = ['example.com', 'example.net', 'example.org'].some(
    (domain) => hostname === domain || hostname.endsWith(`.${domain}`)
  );
  if (usesDocumentationDomain) {
    throw new Error(`Reserved ${label} documentation hostnames cannot be packaged.`);
  }

  const reservedSuffix = ['.example', '.invalid', '.test'].find(
    (suffix) => hostname === suffix.slice(1) || hostname.endsWith(suffix)
  );
  if (reservedSuffix === '.invalid' || reservedSuffix === '.test') {
    throw new Error(`Reserved ${label} hostnames cannot be packaged.`);
  }
  if (reservedSuffix === '.example' && !allowReserved) {
    throw new Error(`Reserved ${label} hostnames are allowed only with --verify-only.`);
  }
}

export function normalizeOAuthEndpoint(value, label, { allowReserved = false } = {}) {
  if (!value || typeof value !== 'string') {
    throw new Error(`Set ${label} to an exact absolute HTTPS endpoint.`);
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`The ${label} must be a valid absolute HTTPS URL.`);
  }

  if (parsed.protocol !== 'https:') {
    throw new Error(`The ${label} must use HTTPS.`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`The ${label} cannot contain credentials.`);
  }
  if (parsed.pathname === '/' || parsed.search || parsed.hash) {
    throw new Error(`The ${label} must include an exact path without a query or fragment.`);
  }
  validateExactHostname(parsed.hostname, label, { allowReserved });

  return parsed.href;
}

function reservedValueSuffix(value) {
  const normalized = value.toLowerCase();
  return ['.example', '.invalid', '.test'].find((suffix) => normalized.endsWith(suffix)) || '';
}

export function normalizeOAuthClientId(value, { allowReserved = false } = {}) {
  if (typeof value !== 'string' || !value || value !== value.trim()) {
    throw new Error('Set ALPHA_OAUTH_CLIENT_ID to the exact public OAuth client ID.');
  }
  if (value.length > 256 || !/^[\x21-\x7e]+$/.test(value)) {
    throw new Error(
      'The public OAuth client ID must be a printable, space-free value of at most 256 characters.'
    );
  }
  if (value === PLACEHOLDER_CLIENT_ID) {
    throw new Error('The placeholder OAuth client ID cannot be packaged.');
  }

  const reservedSuffix = reservedValueSuffix(value);
  if (reservedSuffix === '.invalid' || reservedSuffix === '.test') {
    throw new Error('Reserved OAuth client IDs cannot be packaged.');
  }
  if (reservedSuffix === '.example' && !allowReserved) {
    throw new Error('Reserved OAuth client IDs are allowed only with --verify-only.');
  }
  return value;
}

function scopeReservedSuffix(scope) {
  try {
    const parsed = new URL(scope);
    return reservedValueSuffix(parsed.hostname);
  } catch {
    return reservedValueSuffix(scope);
  }
}

export function normalizeOAuthScopes(value, { allowReserved = false } = {}) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('Set ALPHA_OAUTH_SCOPES to the required space-delimited OAuth scopes.');
  }
  const scopes = value.trim().split(/\s+/);
  if (scopes.length > 20 || scopes.some((scope) => !/^[A-Za-z0-9._~:/-]{1,128}$/.test(scope))) {
    throw new Error('OAuth scopes must match the extension runtime scope grammar.');
  }
  if (new Set(scopes).size !== scopes.length) {
    throw new Error('OAuth scopes cannot contain duplicates.');
  }
  if (!scopes.includes('openid')) {
    throw new Error('OAuth scopes must include openid for the configured OIDC sign-in flow.');
  }
  if (scopes.includes('offline_access')) {
    throw new Error(
      'offline_access is prohibited because the extension cannot retain refresh tokens.'
    );
  }

  const normalized = scopes.join(' ');
  if (normalized === PLACEHOLDER_SCOPES || scopes.includes('alpha.api.invalid')) {
    throw new Error('The placeholder OAuth scope cannot be packaged.');
  }
  for (const scope of scopes) {
    const reservedSuffix = scopeReservedSuffix(scope);
    if (reservedSuffix === '.invalid' || reservedSuffix === '.test') {
      throw new Error('Reserved OAuth scopes cannot be packaged.');
    }
    if (reservedSuffix === '.example' && !allowReserved) {
      throw new Error('Reserved OAuth scopes are allowed only with --verify-only.');
    }
  }
  return normalized;
}

export function normalizeReleaseConfiguration(configuration, { allowReserved = false } = {}) {
  if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration)) {
    throw new Error('A complete extension release configuration is required.');
  }

  return Object.freeze({
    apiOrigin: normalizeProductionApiOrigin(configuration.apiOrigin, { allowReserved }),
    authorizationEndpoint: normalizeOAuthEndpoint(
      configuration.authorizationEndpoint,
      'OAuth authorization endpoint',
      { allowReserved }
    ),
    tokenEndpoint: normalizeOAuthEndpoint(configuration.tokenEndpoint, 'OAuth token endpoint', {
      allowReserved
    }),
    oauthClientId: normalizeOAuthClientId(configuration.oauthClientId, { allowReserved }),
    oauthScopes: normalizeOAuthScopes(configuration.oauthScopes, { allowReserved })
  });
}

function validateReviewedManifest(
  manifest,
  { label, expectedHostPermissions, expectedActionIcons }
) {
  assertExactKeys(manifest, TOP_LEVEL_MANIFEST_KEYS, `${label} manifest top level`);
  if (manifest.manifest_version !== 3) {
    throw new Error(`${label} package must use Manifest V3.`);
  }
  if (!/^\d+\.\d+\.\d+(?:\.\d+)?$/u.test(manifest.version || '')) {
    throw new Error(`${label} manifest must contain a valid Chrome extension version.`);
  }
  if (manifest.name !== EXTENSION_NAME || manifest.description !== EXTENSION_DESCRIPTION) {
    throw new Error(`${label} manifest product metadata does not match the reviewed values.`);
  }
  if (manifest.minimum_chrome_version !== '114') {
    throw new Error(`${label} manifest minimum Chrome version must remain 114.`);
  }

  assertExactJson(manifest.icons, ICON_PATHS, `${label} extension icons`);
  assertExactJson(manifest.permissions, uniqueSorted(ALLOWED_PERMISSIONS), `${label} permissions`);
  assertExactJson(
    manifest.host_permissions,
    uniqueSorted(expectedHostPermissions),
    `${label} host permissions`
  );

  assertExactKeys(manifest.background, ['service_worker'], `${label} background`);
  if (manifest.background.service_worker !== 'background.js') {
    throw new Error(`${label} background must use the reviewed classic background.js worker.`);
  }

  if (!Array.isArray(manifest.content_scripts) || manifest.content_scripts.length !== 1) {
    throw new Error(
      `${label} content_scripts must contain one reviewed isolated, top-frame script stack.`
    );
  }
  const contentScript = manifest.content_scripts[0];
  assertExactKeys(contentScript, ['matches', 'js', 'run_at'], `${label} content script`);
  assertExactJson(
    contentScript.matches,
    SUPPORTED_PAGE_PATTERNS,
    `${label} content script matches`
  );
  assertExactJson(contentScript.js, CONTENT_SCRIPT_FILES, `${label} content script stack`);
  if (contentScript.run_at !== 'document_end') {
    throw new Error(`${label} content script must run at document_end.`);
  }

  assertExactKeys(
    manifest.action,
    ['default_popup', 'default_title', 'default_icon'],
    `${label} action`
  );
  if (
    manifest.action.default_popup !== 'popup.html' ||
    manifest.action.default_title !== ACTION_TITLE
  ) {
    throw new Error(`${label} action popup and title must match the reviewed values.`);
  }
  assertExactJson(manifest.action.default_icon, expectedActionIcons, `${label} action icons`);

  assertExactKeys(
    manifest.content_security_policy,
    ['extension_pages'],
    `${label} content security policy`
  );
  if (manifest.content_security_policy.extension_pages !== EXTENSION_CSP) {
    throw new Error(`${label} extension CSP must exactly match the reviewed restrictive policy.`);
  }

  if (
    !Array.isArray(manifest.web_accessible_resources) ||
    manifest.web_accessible_resources.length !== 1
  ) {
    throw new Error(`${label} manifest must contain one reviewed web-accessible resource group.`);
  }
  const resourceGroup = manifest.web_accessible_resources[0];
  assertExactKeys(
    resourceGroup,
    ['resources', 'matches'],
    `${label} web-accessible resource group`
  );
  assertExactJson(
    resourceGroup.resources,
    ['floating-frame.html'],
    `${label} web-accessible resources`
  );
  assertExactJson(
    resourceGroup.matches,
    SUPPORTED_PAGE_PATTERNS,
    `${label} web-accessible resource matches`
  );
}

function validateDevelopmentManifest(source) {
  validateReviewedManifest(source, {
    label: 'Development',
    expectedHostPermissions: DEVELOPMENT_HOSTS,
    expectedActionIcons: DEVELOPMENT_ACTION_ICONS
  });
}

export function buildProductionManifest(
  sourceManifest,
  configuration,
  { allowReserved = false } = {}
) {
  const source = structuredClone(sourceManifest);
  validateDevelopmentManifest(source);
  const normalized = normalizeReleaseConfiguration(configuration, { allowReserved });
  const apiPattern = `${normalized.apiOrigin}/*`;
  const tokenEndpointPattern = `${new URL(normalized.tokenEndpoint).origin}/*`;

  source.permissions = uniqueSorted([...(source.permissions || []), 'identity']);
  source.host_permissions = uniqueSorted([apiPattern, tokenEndpointPattern]);
  source.icons = { ...ICON_PATHS };
  source.action = {
    default_popup: 'popup.html',
    default_title: ACTION_TITLE,
    default_icon: { ...ICON_PATHS }
  };

  validateProductionManifest(source, normalized, { allowReserved });
  return source;
}

export function validateProductionManifest(
  manifest,
  configuration,
  { allowReserved = false } = {}
) {
  const normalized = normalizeReleaseConfiguration(configuration, { allowReserved });
  const expectedApiPattern = `${normalized.apiOrigin}/*`;
  const expectedTokenEndpointPattern = `${new URL(normalized.tokenEndpoint).origin}/*`;
  validateReviewedManifest(manifest, {
    label: 'Production',
    expectedHostPermissions: [expectedApiPattern, expectedTokenEndpointPattern],
    expectedActionIcons: ICON_PATHS
  });
}
