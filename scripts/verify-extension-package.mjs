import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  ICON_PATHS,
  normalizeReleaseConfiguration,
  validateProductionManifest
} from './extension-manifest-policy.mjs';
import { readDeterministicZip } from './lib/deterministic-zip.mjs';

const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');
export const BACKGROUND_IMPORT_FILES = Object.freeze([
  'modules/config.js',
  'modules/runtime.js',
  'modules/dlp.js',
  'modules/api-client.js',
  'modules/auth.js'
]);
export const REVIEWED_RUNTIME_FILES = Object.freeze(
  [
    'assets/fonts/Boldonse-Regular.ttf',
    'assets/fonts/OFL.txt',
    'assets/icons/icon-128.png',
    'assets/icons/icon-16.png',
    'assets/icons/icon-32.png',
    'assets/icons/icon-48.png',
    'background.js',
    'content.js',
    'floating-frame.html',
    'floating-frame.js',
    'modules/api-client.js',
    'modules/auth.js',
    'modules/config.js',
    'modules/content-observer.js',
    'modules/dlp.js',
    'modules/floating-ui.js',
    'modules/frame-protocol.js',
    'modules/platform-adapters.js',
    'modules/runtime.js',
    'popup.html',
    'popup.js',
    'privacy.html',
    'styles.css'
  ].sort()
);
export const REVIEWED_ARCHIVE_FILES = Object.freeze(
  ['manifest.json', ...REVIEWED_RUNTIME_FILES].sort()
);
const REVIEWED_ARCHIVE_FILE_SET = new Set(REVIEWED_ARCHIVE_FILES);
const FORBIDDEN_FILE_PATTERNS = [
  /(^|\/)\.env(?:\.|$)/i,
  /(^|\/)(?:test|tests|__tests__)(?:\/|$)/i,
  /(^|\/)options\.(?:html|js)$/i,
  /\.map$/i,
  /\.(?:pem|p12|pfx|key)$/i,
  /(^|\/)manifest\.(?:development|production)\.json$/i
];
const FORBIDDEN_RUNTIME_TEXT = [
  ['localhost URL', /http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?/i],
  ['unresolved development API origin', /https:\/\/api\.alpha\.invalid/i],
  ['unresolved OAuth provider endpoint', /https:\/\/auth\.alpha\.invalid/i],
  ['unresolved OAuth client ID', /alpha-extension-client\.invalid/i],
  ['unresolved OAuth scope', /alpha\.api\.invalid/i],
  [
    'unresolved release configuration token',
    /__ALPHA_(?:API_ORIGIN|OAUTH_(?:AUTHORIZATION_ENDPOINT|TOKEN_ENDPOINT|CLIENT_ID|SCOPES))__/
  ],
  ['provider secret name', /GEMINI_API_KEY/],
  ['legacy shared gateway key', /GATEWAY_API_KEY|gatewayApiKey|X-Alpha-Key/],
  [
    'remotely hosted JavaScript import',
    /(?:\bfrom\s*|\bimport\s*\(|\bimportScripts\s*\()\s*["'](?:https?:)?\/\//i
  ]
];

function decodeJson(buffer, name) {
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch (error) {
    throw new Error(`${name} is not valid JSON: ${error.message}`);
  }
}

function pngDimensions(buffer, name) {
  if (
    buffer.length < 24 ||
    !buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) ||
    buffer.subarray(12, 16).toString('ascii') !== 'IHDR'
  ) {
    throw new Error(`${name} is not a valid PNG with an IHDR header.`);
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function validateBackgroundImports(contents) {
  const source = contents.toString('utf8');
  const call = source.match(/^\s*importScripts\(([\s\S]*?)\);\s*/u);
  if (!call || /\bimportScripts\s*\(/u.test(source.slice(call[0].length))) {
    throw new Error(
      'Packaged background.js must begin with one literal reviewed importScripts dependency stack.'
    );
  }
  const dependencies = call[1]
    .split(',')
    .map((argument) => argument.trim())
    .filter(Boolean)
    .map((argument) => {
      const literal = argument.match(/^(['"])([^'"\\\r\n]+)\1$/u);
      if (!literal) {
        throw new Error('Packaged background.js importScripts arguments must be string literals.');
      }
      return literal[2];
    });
  if (JSON.stringify(dependencies) !== JSON.stringify(BACKGROUND_IMPORT_FILES)) {
    throw new Error(
      'Packaged background.js importScripts dependencies must exactly match the reviewed stack.'
    );
  }
}

export function createReviewedConfigSource(configuration) {
  return `(function initializeAlphaConfig(globalScope) {
  'use strict';

  globalScope.AlphaConfig = Object.freeze({
    API_ORIGIN: ${JSON.stringify(configuration.apiOrigin)},
    OAUTH_AUTHORIZATION_ENDPOINT: ${JSON.stringify(configuration.authorizationEndpoint)},
    OAUTH_TOKEN_ENDPOINT: ${JSON.stringify(configuration.tokenEndpoint)},
    OAUTH_CLIENT_ID: ${JSON.stringify(configuration.oauthClientId)},
    OAUTH_SCOPES: ${JSON.stringify(configuration.oauthScopes)},
    OAUTH_REDIRECT_PATH: 'alpha-oauth'
  });
})(globalThis);
`;
}

function referencedManifestFiles(manifest) {
  const references = new Set();
  const add = (value) => {
    if (typeof value === 'string' && value) references.add(value);
  };
  const addIconSet = (iconSet) => {
    for (const value of Object.values(iconSet || {})) add(value);
  };

  add(manifest.background?.service_worker);
  add(manifest.action?.default_popup);
  addIconSet(manifest.icons);
  addIconSet(manifest.action?.default_icon);
  for (const script of manifest.content_scripts || []) {
    for (const file of script.js || []) add(file);
    for (const file of script.css || []) add(file);
  }
  for (const group of manifest.web_accessible_resources || []) {
    for (const file of group.resources || []) {
      if (!file.includes('*')) add(file);
    }
  }
  return references;
}

function validateHtml(name, contents) {
  const text = contents.toString('utf8');
  const scriptTags = [...text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)];
  for (const match of scriptTags) {
    const attributes = match[1];
    const inlineBody = match[2].trim();
    const source = attributes.match(/\bsrc\s*=\s*["']([^"']+)["']/i)?.[1];
    if (!source && inlineBody) {
      throw new Error(`${name} contains inline JavaScript, which Manifest V3 blocks.`);
    }
    if (source && /^(?:https?:|data:|\/\/)/i.test(source)) {
      throw new Error(`${name} loads remote JavaScript: ${source}`);
    }
  }
  return referencedHtmlFiles(name, text);
}

function normalizedLocalReference(ownerName, reference) {
  const value = String(reference || '').trim();
  if (!value || /[?#]/u.test(value) || value.includes('\\')) {
    throw new Error(`${ownerName} contains an invalid local resource reference: ${value}`);
  }
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|\/)/iu.test(value)) {
    throw new Error(`${ownerName} contains a non-local resource reference: ${value}`);
  }
  let decoded;
  try {
    decoded = decodeURIComponent(value);
  } catch (_error) {
    throw new Error(`${ownerName} contains an invalid encoded resource reference: ${value}`);
  }
  if (decoded.includes('\\') || /(^|\/)\.\.(?:\/|$)/u.test(decoded)) {
    throw new Error(`${ownerName} contains a traversing resource reference: ${value}`);
  }
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(ownerName), decoded));
  if (
    !resolved ||
    resolved === '..' ||
    resolved.startsWith('../') ||
    path.posix.isAbsolute(resolved)
  ) {
    throw new Error(`${ownerName} contains an unsafe resource reference: ${value}`);
  }
  return resolved;
}

function attributeValue(tag, name) {
  return tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, 'iu'))?.[1] || '';
}

function referencedCssFiles(name, text) {
  const references = new Set();
  for (const match of text.matchAll(/\burl\(\s*(["']?)([^"')]+)\1\s*\)/giu)) {
    references.add(normalizedLocalReference(name, match[2]));
  }
  for (const match of text.matchAll(/@import\s+(?:url\(\s*)?["']([^"']+)["']/giu)) {
    references.add(normalizedLocalReference(name, match[1]));
  }
  return references;
}

function referencedHtmlFiles(name, text) {
  const references = referencedCssFiles(name, text);
  for (const match of text.matchAll(/<(script|link|a|img|iframe|source|audio|video)\b[^>]*>/giu)) {
    const tagName = match[1].toLowerCase();
    const tag = match[0];
    const attribute = tagName === 'link' || tagName === 'a' ? 'href' : 'src';
    const resource = attributeValue(tag, attribute);
    if (resource && tagName === 'a' && /^[a-z][a-z0-9+.-]*:/iu.test(resource)) {
      let external;
      try {
        external = new URL(resource);
      } catch (_error) {
        throw new Error(`${name} contains an invalid external link: ${resource}`);
      }
      if (external.protocol !== 'https:') {
        throw new Error(`${name} contains an unsafe external link: ${resource}`);
      }
    } else if (resource) {
      references.add(normalizedLocalReference(name, resource));
    }
    if (tagName === 'video') {
      const poster = attributeValue(tag, 'poster');
      if (poster) references.add(normalizedLocalReference(name, poster));
    }
  }
  return references;
}

export function verifyExtensionArchive(archive, configuration, { allowReserved = false } = {}) {
  const normalized = normalizeReleaseConfiguration(configuration, { allowReserved });
  const entries = readDeterministicZip(archive);
  if (!entries.has('manifest.json')) {
    throw new Error('manifest.json must be present at the ZIP root.');
  }

  for (const name of entries.keys()) {
    if (FORBIDDEN_FILE_PATTERNS.some((pattern) => pattern.test(name))) {
      throw new Error(`Developer-only or sensitive file found in package: ${name}`);
    }
  }
  const archiveNames = [...entries.keys()];
  const missingFiles = REVIEWED_ARCHIVE_FILES.filter((name) => !entries.has(name));
  if (missingFiles.length) {
    throw new Error(`Production archive is missing reviewed files: ${missingFiles.join(', ')}`);
  }
  const unexpectedFiles = archiveNames.filter((name) => !REVIEWED_ARCHIVE_FILE_SET.has(name));
  if (unexpectedFiles.length) {
    throw new Error(
      `Production archive contains unreviewed files: ${unexpectedFiles.sort().join(', ')}`
    );
  }

  const manifest = decodeJson(entries.get('manifest.json'), 'manifest.json');
  validateProductionManifest(manifest, normalized, { allowReserved });
  validateBackgroundImports(entries.get('background.js'));

  for (const reference of referencedManifestFiles(manifest)) {
    if (!entries.has(reference)) {
      throw new Error(`Manifest references a missing package file: ${reference}`);
    }
  }

  for (const [sizeText, iconPath] of Object.entries(ICON_PATHS)) {
    const expectedSize = Number(sizeText);
    const icon = entries.get(iconPath);
    if (!icon) throw new Error(`Required icon is missing: ${iconPath}`);
    const dimensions = pngDimensions(icon, iconPath);
    if (dimensions.width !== expectedSize || dimensions.height !== expectedSize) {
      throw new Error(`${iconPath} must be exactly ${expectedSize}x${expectedSize}px.`);
    }
  }

  const localReferences = new Map();
  for (const [name, contents] of entries) {
    if (name.endsWith('.html')) {
      for (const reference of validateHtml(name, contents)) {
        localReferences.set(`${name} -> ${reference}`, reference);
      }
    }
    if (name.endsWith('.css')) {
      for (const reference of referencedCssFiles(name, contents.toString('utf8'))) {
        localReferences.set(`${name} -> ${reference}`, reference);
      }
    }
    if (!/\.(?:html|js|json)$/i.test(name)) continue;
    const text = contents.toString('utf8');
    for (const [label, pattern] of FORBIDDEN_RUNTIME_TEXT) {
      if (pattern.test(text)) {
        throw new Error(`Production package contains ${label} in ${name}.`);
      }
    }
  }
  for (const [source, reference] of localReferences) {
    if (!entries.has(reference)) {
      throw new Error(`Packaged local resource is missing: ${source}`);
    }
  }

  const packagedConfiguration = entries.get('modules/config.js');
  const expectedConfiguration = Buffer.from(createReviewedConfigSource(normalized), 'utf8');
  if (!packagedConfiguration.equals(expectedConfiguration)) {
    throw new Error(
      'Packaged modules/config.js does not byte-match the reviewed active configuration template.'
    );
  }

  return {
    configuration: normalized,
    entryCount: entries.size,
    manifest,
    names: [...entries.keys()].sort()
  };
}

export function parseVerifierArguments(argv, environment = process.env) {
  const output = {
    archivePath: '',
    apiOrigin: environment.ALPHA_API_ORIGIN || '',
    authorizationEndpoint: environment.ALPHA_OAUTH_AUTHORIZATION_ENDPOINT || '',
    help: false,
    oauthClientId: environment.ALPHA_OAUTH_CLIENT_ID || '',
    oauthScopes: environment.ALPHA_OAUTH_SCOPES || '',
    tokenEndpoint: environment.ALPHA_OAUTH_TOKEN_ENDPOINT || '',
    verifyOnly: false
  };
  for (const argument of argv) {
    if (argument.startsWith('--api-origin=')) output.apiOrigin = argument.slice(13);
    else if (argument.startsWith('--oauth-authorization-endpoint=')) {
      output.authorizationEndpoint = argument.slice(31);
    } else if (argument.startsWith('--oauth-token-endpoint=')) {
      output.tokenEndpoint = argument.slice(23);
    } else if (argument.startsWith('--oauth-client-id=')) {
      output.oauthClientId = argument.slice(18);
    } else if (argument.startsWith('--oauth-scopes=')) {
      output.oauthScopes = argument.slice(15);
    } else if (argument === '--verify-only') output.verifyOnly = true;
    else if (argument === '--help' || argument === '-h') output.help = true;
    else if (!output.archivePath) output.archivePath = argument;
    else throw new Error(`Unexpected argument: ${argument}`);
  }
  if (!output.archivePath && !output.help) {
    throw new Error(
      'Usage: npm run verify:extension -- <archive.zip> --api-origin=... --oauth-authorization-endpoint=... --oauth-token-endpoint=... --oauth-client-id=... --oauth-scopes="openid alpha.api"'
    );
  }
  return output;
}

async function main() {
  const options = parseVerifierArguments(process.argv.slice(2));
  if (options.help) {
    console.log(
      'Usage: npm run verify:extension -- <archive.zip> --api-origin=... --oauth-authorization-endpoint=... --oauth-token-endpoint=... --oauth-client-id=... --oauth-scopes="openid alpha.api" [--verify-only]'
    );
    return;
  }
  const archive = await readFile(path.resolve(options.archivePath));
  const result = verifyExtensionArchive(archive, options, {
    allowReserved: options.verifyOnly
  });
  console.log(`Verified ${options.archivePath}: ${result.entryCount} files, Manifest V3.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
