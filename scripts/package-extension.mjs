import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  buildProductionManifest,
  normalizeReleaseConfiguration
} from './extension-manifest-policy.mjs';
import { createDeterministicZip } from './lib/deterministic-zip.mjs';
import { REVIEWED_RUNTIME_FILES, verifyExtensionArchive } from './verify-extension-package.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSION_DIRECTORY = path.join(ROOT, 'extension');

const REVIEWED_RUNTIME_FILE_SET = new Set(REVIEWED_RUNTIME_FILES);
const BUILD_PLACEHOLDERS = Object.freeze({
  apiOrigin: ['__ALPHA_API_ORIGIN__', 'https://api.alpha.invalid'],
  authorizationEndpoint: [
    '__ALPHA_OAUTH_AUTHORIZATION_ENDPOINT__',
    'https://auth.alpha.invalid/oauth2/authorize'
  ],
  tokenEndpoint: ['__ALPHA_OAUTH_TOKEN_ENDPOINT__', 'https://auth.alpha.invalid/oauth2/token'],
  oauthClientId: ['__ALPHA_OAUTH_CLIENT_ID__', 'alpha-extension-client.invalid'],
  oauthScopes: ['__ALPHA_OAUTH_SCOPES__', 'openid alpha.api.invalid']
});

export const PACKAGE_USAGE = `Usage: npm run package:extension -- \\
  --api-origin=https://api.your-domain.com \\
  --oauth-authorization-endpoint=https://identity.your-domain.com/oauth2/authorize \\
  --oauth-token-endpoint=https://identity.your-domain.com/oauth2/token \\
  --oauth-client-id=public-client-id \\
  --oauth-scopes="openid alpha.api" \\
  [--output=artifacts/alpha-extension-release.zip] [--verify-only]

The same values can be supplied with ALPHA_API_ORIGIN,
ALPHA_OAUTH_AUTHORIZATION_ENDPOINT, ALPHA_OAUTH_TOKEN_ENDPOINT,
ALPHA_OAUTH_CLIENT_ID, and ALPHA_OAUTH_SCOPES. --verify-only permits
reserved .example values for deterministic CI packages; release builds reject them.`;

function isReviewedRuntimeFile(relativePath) {
  return REVIEWED_RUNTIME_FILE_SET.has(relativePath);
}

async function walk(directory, prefix = '') {
  const output = [];
  const children = await readdir(directory, { withFileTypes: true });
  children.sort((left, right) => left.name.localeCompare(right.name, 'en-US'));
  for (const child of children) {
    if (child.name.startsWith('.')) continue;
    const relativePath = prefix ? `${prefix}/${child.name}` : child.name;
    const absolutePath = path.join(directory, child.name);
    if (child.isDirectory()) output.push(...(await walk(absolutePath, relativePath)));
    else if (child.isFile()) output.push(relativePath);
    else throw new Error(`Extension source cannot contain links or special files: ${relativePath}`);
  }
  return output;
}

async function collectRuntimeEntries() {
  const paths = await walk(EXTENSION_DIRECTORY);
  const entries = [];
  for (const relativePath of paths) {
    if (relativePath === 'manifest.json') continue;
    if (!isReviewedRuntimeFile(relativePath)) {
      throw new Error(`Unreviewed extension file is not allowed in production: ${relativePath}`);
    }
    entries.push({
      name: relativePath,
      data: await readFile(path.join(EXTENSION_DIRECTORY, relativePath))
    });
  }
  const packagedNames = new Set(entries.map((entry) => entry.name));
  const missingFiles = REVIEWED_RUNTIME_FILES.filter((name) => !packagedNames.has(name));
  if (missingFiles.length) {
    throw new Error(
      `Extension source is missing reviewed runtime files: ${missingFiles.join(', ')}`
    );
  }
  return entries;
}

function replaceBuildTokens(entry, configuration) {
  if (!/\.(?:html|js|json)$/i.test(entry.name)) return entry;
  let replaced = entry.data.toString('utf8');
  for (const [key, placeholders] of Object.entries(BUILD_PLACEHOLDERS)) {
    for (const placeholder of placeholders) {
      const serializedValue = JSON.stringify(configuration[key]);
      replaced = replaced
        .replaceAll(`'${placeholder}'`, serializedValue)
        .replaceAll(`"${placeholder}"`, serializedValue);
      if (replaced.includes(placeholder)) {
        throw new Error(
          `Build placeholder in ${entry.name} must be one complete quoted string literal: ${placeholder}`
        );
      }
    }
  }
  return { ...entry, data: Buffer.from(replaced, 'utf8') };
}

export async function createExtensionPackage({
  apiOrigin,
  authorizationEndpoint,
  tokenEndpoint,
  oauthClientId,
  oauthScopes,
  outputPath,
  verifyOnly = false
}) {
  const configuration = normalizeReleaseConfiguration(
    { apiOrigin, authorizationEndpoint, tokenEndpoint, oauthClientId, oauthScopes },
    { allowReserved: verifyOnly }
  );
  const sourceManifest = JSON.parse(
    await readFile(path.join(EXTENSION_DIRECTORY, 'manifest.json'), 'utf8')
  );
  const manifest = buildProductionManifest(sourceManifest, configuration, {
    allowReserved: verifyOnly
  });
  const runtimeEntries = (await collectRuntimeEntries()).map((entry) =>
    replaceBuildTokens(entry, configuration)
  );
  const entries = [
    ...runtimeEntries,
    {
      name: 'manifest.json',
      data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    }
  ];
  const archive = createDeterministicZip(entries);
  let persistedArchive = archive;
  let verification = verifyExtensionArchive(archive, configuration, {
    allowReserved: verifyOnly
  });

  if (outputPath) {
    const absoluteOutput = path.resolve(outputPath);
    await mkdir(path.dirname(absoluteOutput), { recursive: true });
    const temporaryOutput = `${absoluteOutput}.tmp-${process.pid}`;
    await writeFile(temporaryOutput, archive, { mode: 0o644 });
    await rename(temporaryOutput, absoluteOutput);
    persistedArchive = await readFile(absoluteOutput);
    if (!persistedArchive.equals(archive)) {
      throw new Error('Persisted extension archive does not match the deterministic build output.');
    }
  }

  if (outputPath) {
    verification = verifyExtensionArchive(persistedArchive, configuration, {
      allowReserved: verifyOnly
    });
  }

  return {
    archive: persistedArchive,
    configuration,
    manifest,
    sha256: createHash('sha256').update(persistedArchive).digest('hex'),
    verification
  };
}

export function parsePackageArguments(argv, environment = process.env) {
  const options = {
    apiOrigin: environment.ALPHA_API_ORIGIN || '',
    authorizationEndpoint: environment.ALPHA_OAUTH_AUTHORIZATION_ENDPOINT || '',
    help: false,
    oauthClientId: environment.ALPHA_OAUTH_CLIENT_ID || '',
    oauthScopes: environment.ALPHA_OAUTH_SCOPES || '',
    outputPath: '',
    tokenEndpoint: environment.ALPHA_OAUTH_TOKEN_ENDPOINT || '',
    verifyOnly: false
  };
  for (const argument of argv) {
    if (argument.startsWith('--api-origin=')) options.apiOrigin = argument.slice(13);
    else if (argument.startsWith('--oauth-authorization-endpoint=')) {
      options.authorizationEndpoint = argument.slice(31);
    } else if (argument.startsWith('--oauth-token-endpoint=')) {
      options.tokenEndpoint = argument.slice(23);
    } else if (argument.startsWith('--oauth-client-id=')) {
      options.oauthClientId = argument.slice(18);
    } else if (argument.startsWith('--oauth-scopes=')) {
      options.oauthScopes = argument.slice(15);
    } else if (argument.startsWith('--output=')) options.outputPath = argument.slice(9);
    else if (argument === '--verify-only') options.verifyOnly = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else throw new Error(`Unexpected argument: ${argument}`);
  }
  return options;
}

async function main() {
  const options = parsePackageArguments(process.argv.slice(2));
  if (options.help) {
    console.log(PACKAGE_USAGE);
    return;
  }
  const sourceManifest = JSON.parse(
    await readFile(path.join(EXTENSION_DIRECTORY, 'manifest.json'), 'utf8')
  );
  const defaultName = `artifacts/alpha-extension-${sourceManifest.version}.zip`;
  const outputPath = options.outputPath || defaultName;
  const result = await createExtensionPackage({
    ...options,
    outputPath
  });
  console.log(`Created ${outputPath}`);
  console.log(`SHA-256 ${result.sha256}`);
  console.log(`Verified ${result.verification.entryCount} production files.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
