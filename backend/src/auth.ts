import { createPublicKey, timingSafeEqual, verify as verifySignature } from 'node:crypto';
import type { JsonWebKey, KeyObject } from 'node:crypto';
import type { ReadableStreamDefaultReader } from 'node:stream/web';
import { ApiError } from './errors.js';
import type { AuthPrincipal } from './types.js';

const MAX_TOKEN_CHARACTERS = 8192;
const MAX_JWKS_BYTES = 1024 * 1024;

interface JwtHeader {
  alg: string;
  kid: string;
  typ?: string;
  crit?: unknown;
}

interface JwtClaims {
  iss: string;
  sub: string;
  aud: string | string[];
  exp: number;
  iat: number;
  nbf?: number;
  scope?: string;
}

interface JwkRecord extends JsonWebKey {
  kid?: string;
  alg?: string;
  use?: string;
}

interface JwksDocument {
  keys: JwkRecord[];
}

async function readBoundedResponseText(response: Response, maximumBytes: number): Promise<string> {
  const contentLengthHeader = response.headers.get('content-length');
  if (contentLengthHeader) {
    const contentLength = Number(contentLengthHeader);
    if (
      !/^\d+$/.test(contentLengthHeader) ||
      !Number.isSafeInteger(contentLength) ||
      contentLength > maximumBytes
    ) {
      void response.body?.cancel('JWKS response declared an invalid byte length.').catch(() => {});
      throw new Error('JWKS response is too large.');
    }
  }

  const reader = response.body?.getReader() as ReadableStreamDefaultReader<Uint8Array> | undefined;
  if (!reader) {
    const fallback = new Uint8Array(await response.arrayBuffer());
    if (fallback.byteLength > maximumBytes) throw new Error('JWKS response is too large.');
    return Buffer.from(fallback).toString('utf8');
  }

  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > maximumBytes) {
        void reader.cancel('JWKS response exceeded the configured byte limit.').catch(() => {});
        throw new Error('JWKS response is too large.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)),
    receivedBytes
  ).toString('utf8');
}

export interface Authenticator {
  authenticate(headers: Record<string, string | string[] | undefined>): Promise<AuthPrincipal>;
  ready(): Promise<boolean>;
  close(): Promise<void>;
}

export interface TokenVerifierOptions {
  jwksUri: string;
  issuer: string;
  audience: string;
  requiredScopes: string[];
  algorithms: string[];
  clockToleranceSeconds: number;
  maxTokenAgeSeconds: number;
  cacheTtlMs: number;
  timeoutMs: number;
  fetchImplementation?: typeof fetch;
  now?: () => number;
}

function decodeJsonSegment<T>(segment: string): T {
  if (!segment || segment.length > MAX_TOKEN_CHARACTERS || !/^[A-Za-z0-9_-]+$/.test(segment)) {
    throw new Error('Invalid JWT encoding.');
  }
  const decoded = Buffer.from(segment, 'base64url').toString('utf8');
  const value: unknown = JSON.parse(decoded);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid JWT object.');
  }
  return value as T;
}

function assertJwtShape(header: JwtHeader, claims: JwtClaims): void {
  if (
    typeof header.alg !== 'string' ||
    typeof header.kid !== 'string' ||
    !header.kid ||
    header.kid.length > 256 ||
    (header.typ !== undefined && header.typ.toUpperCase() !== 'JWT') ||
    typeof claims.iss !== 'string' ||
    !claims.iss ||
    typeof claims.sub !== 'string' ||
    !claims.sub ||
    claims.sub.length > 255 ||
    !(
      typeof claims.aud === 'string' ||
      (Array.isArray(claims.aud) &&
        claims.aud.length > 0 &&
        claims.aud.every((item) => typeof item === 'string' && item.length > 0))
    ) ||
    !Number.isSafeInteger(claims.exp) ||
    claims.exp <= 0 ||
    !Number.isSafeInteger(claims.iat) ||
    claims.iat <= 0 ||
    (claims.scope !== undefined &&
      (typeof claims.scope !== 'string' || claims.scope.length > 4096)) ||
    (claims.nbf !== undefined && !Number.isSafeInteger(claims.nbf))
  ) {
    throw new Error('Invalid JWT claims.');
  }
}

function signatureAlgorithm(algorithm: string): { digest: string; dsaEncoding?: 'ieee-p1363' } {
  switch (algorithm) {
    case 'RS256':
      return { digest: 'RSA-SHA256' };
    case 'RS384':
      return { digest: 'RSA-SHA384' };
    case 'RS512':
      return { digest: 'RSA-SHA512' };
    case 'ES256':
      return { digest: 'SHA256', dsaEncoding: 'ieee-p1363' };
    case 'ES384':
      return { digest: 'SHA384', dsaEncoding: 'ieee-p1363' };
    default:
      throw new Error('Unsupported JWT algorithm.');
  }
}

export class JwksTokenVerifier {
  private readonly fetchImplementation: typeof fetch;
  private readonly now: () => number;
  private cachedKeys = new Map<string, JwkRecord>();
  private cacheExpiresAt = 0;
  private lastRefreshAt = 0;
  private lastForcedKeyRefreshAt = 0;
  private refreshPromise: Promise<void> | null = null;

  constructor(private readonly options: TokenVerifierOptions) {
    this.fetchImplementation = options.fetchImplementation || fetch;
    this.now = options.now || Date.now;
  }

  private async refreshKeys(): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = (async () => {
      const response = await this.fetchImplementation(this.options.jwksUri, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(this.options.timeoutMs)
      });
      if (!response.ok) throw new Error('JWKS endpoint returned an error.');
      const contentType = response.headers.get('content-type')?.toLowerCase() || '';
      if (contentType && !contentType.includes('json')) {
        throw new Error('JWKS response is not JSON.');
      }
      const text = await readBoundedResponseText(response, MAX_JWKS_BYTES);
      const document = JSON.parse(text) as Partial<JwksDocument>;
      if (!Array.isArray(document.keys) || document.keys.length < 1 || document.keys.length > 100) {
        throw new Error('JWKS document has no usable keys.');
      }
      const next = new Map<string, JwkRecord>();
      for (const key of document.keys) {
        if (
          key &&
          typeof key === 'object' &&
          typeof key.kid === 'string' &&
          key.kid.length > 0 &&
          key.kid.length <= 256 &&
          (key.use === undefined || key.use === 'sig')
        ) {
          if (typeof key.d === 'string') {
            throw new Error('JWKS document must not contain private keys.');
          }
          if (next.has(key.kid)) {
            throw new Error('JWKS document contains duplicate key identifiers.');
          }
          next.set(key.kid, key);
        }
      }
      if (next.size === 0) throw new Error('JWKS document has no signing keys.');
      this.cachedKeys = next;
      this.lastRefreshAt = this.now();
      this.cacheExpiresAt = this.lastRefreshAt + this.options.cacheTtlMs;
    })().finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }

  private async getKey(kid: string, algorithm: string): Promise<KeyObject> {
    const refreshedForThisRequest = this.cacheExpiresAt <= this.now();
    if (refreshedForThisRequest) await this.refreshKeys();
    let jwk = this.cachedKeys.get(kid);
    const rotationRefreshCooldownMs = Math.min(30000, this.options.cacheTtlMs);
    if (
      !jwk &&
      !refreshedForThisRequest &&
      this.now() - this.lastForcedKeyRefreshAt >= rotationRefreshCooldownMs
    ) {
      this.lastForcedKeyRefreshAt = this.now();
      await this.refreshKeys();
      jwk = this.cachedKeys.get(kid);
    }
    if (!jwk || (jwk.alg !== undefined && jwk.alg !== algorithm)) {
      throw new Error('No matching signing key.');
    }
    if (Array.isArray(jwk.key_ops) && !jwk.key_ops.includes('verify')) {
      throw new Error('Signing key is not permitted for verification.');
    }
    const expectedKeyType = algorithm.startsWith('RS') ? 'RSA' : 'EC';
    if (jwk.kty !== expectedKeyType) {
      throw new Error('Signing key type does not match the JWT algorithm.');
    }
    if (
      (algorithm === 'ES256' && jwk.crv !== 'P-256') ||
      (algorithm === 'ES384' && jwk.crv !== 'P-384')
    ) {
      throw new Error('Signing key curve does not match the JWT algorithm.');
    }
    const key = createPublicKey({ key: jwk, format: 'jwk' });
    if (algorithm.startsWith('RS') && (key.asymmetricKeyDetails?.modulusLength || 0) < 2048) {
      throw new Error('RSA signing keys must be at least 2048 bits.');
    }
    return key;
  }

  async verify(token: string): Promise<AuthPrincipal> {
    if (!token || token.length > MAX_TOKEN_CHARACTERS) throw new Error('Invalid bearer token.');
    const segments = token.split('.');
    if (segments.length !== 3) throw new Error('Invalid bearer token.');
    const [encodedHeader, encodedClaims, encodedSignature] = segments;
    if (!encodedSignature || !/^[A-Za-z0-9_-]+$/.test(encodedSignature)) {
      throw new Error('Invalid JWT signature encoding.');
    }
    const header = decodeJsonSegment<JwtHeader>(encodedHeader);
    const claims = decodeJsonSegment<JwtClaims>(encodedClaims);
    assertJwtShape(header, claims);
    if (header.crit !== undefined) throw new Error('Critical JWT extensions are not supported.');
    if (!this.options.algorithms.includes(header.alg)) {
      throw new Error('JWT algorithm is not allowed.');
    }

    const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    const nowSeconds = Math.floor(this.now() / 1000);
    const tolerance = this.options.clockToleranceSeconds;
    if (
      claims.iss !== this.options.issuer ||
      !audience.includes(this.options.audience) ||
      claims.exp <= nowSeconds - tolerance ||
      claims.exp <= claims.iat ||
      claims.iat > nowSeconds + tolerance ||
      nowSeconds - claims.iat > this.options.maxTokenAgeSeconds + tolerance ||
      claims.exp - claims.iat > this.options.maxTokenAgeSeconds + tolerance ||
      (claims.nbf !== undefined && claims.nbf > nowSeconds + tolerance)
    ) {
      throw new Error('JWT claims are not valid.');
    }

    const key = await this.getKey(header.kid, header.alg);
    const signature = Buffer.from(encodedSignature, 'base64url');
    const algorithm = signatureAlgorithm(header.alg);
    const valid = verifySignature(
      algorithm.digest,
      Buffer.from(`${encodedHeader}.${encodedClaims}`),
      algorithm.dsaEncoding ? { key, dsaEncoding: algorithm.dsaEncoding } : key,
      signature
    );
    if (!valid) throw new Error('JWT signature is invalid.');

    const scopes = typeof claims.scope === 'string' ? claims.scope.split(' ').filter(Boolean) : [];
    const grantedScopes = new Set(scopes);
    if (this.options.requiredScopes.some((scope) => !grantedScopes.has(scope))) {
      throw new Error('JWT does not grant the required API scope.');
    }

    return {
      subject: claims.sub,
      issuer: claims.iss,
      audience,
      scopes,
      authMethod: 'bearer'
    };
  }

  async ready(): Promise<boolean> {
    try {
      if (this.cacheExpiresAt <= this.now()) await this.refreshKeys();
      return this.cachedKeys.size > 0;
    } catch {
      return false;
    }
  }
}

function validLegacyKey(
  expectedValue: string,
  receivedValue: string | string[] | undefined
): boolean {
  if (typeof receivedValue !== 'string' || receivedValue.length > 256) return false;
  const expected = Buffer.from(expectedValue);
  const received = Buffer.from(receivedValue);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

export function createAuthenticator(options: {
  verifier?: JwksTokenVerifier;
  legacyDevelopmentKey?: string;
}): Authenticator {
  return {
    async authenticate(headers) {
      try {
        const authorization = headers.authorization;
        if (authorization !== undefined) {
          if (
            typeof authorization !== 'string' ||
            authorization.length > MAX_TOKEN_CHARACTERS + 7 ||
            !authorization.startsWith('Bearer ') ||
            !options.verifier
          ) {
            throw new Error('Invalid authorization header.');
          }
          return await options.verifier.verify(authorization.slice(7));
        }
        if (
          options.legacyDevelopmentKey &&
          validLegacyKey(options.legacyDevelopmentKey, headers['x-alpha-key'])
        ) {
          return {
            subject: 'legacy-development-client',
            issuer: 'alpha-development',
            audience: ['alpha-api'],
            scopes: [],
            authMethod: 'legacy-development-key'
          };
        }
      } catch {
        // Authentication responses intentionally do not reveal why verification failed.
      }
      throw new ApiError(401, 'AUTHENTICATION_REQUIRED', 'Authentication required.');
    },
    async ready() {
      if (options.verifier) return options.verifier.ready();
      return Boolean(options.legacyDevelopmentKey);
    },
    async close() {}
  };
}
