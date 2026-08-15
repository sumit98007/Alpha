(function initializeAlphaAuth(globalScope) {
  'use strict';

  const { sessionGet, sessionRemove, sessionSet } = globalScope.AlphaRuntime;
  const config = globalScope.AlphaConfig;
  const AUTH_FLOW_TIMEOUT_MS = 90_000;
  const TOKEN_TIMEOUT_MS = 10_000;
  const MAX_TOKEN_RESPONSE_BYTES = 64_000;
  const MAX_ACCESS_TOKEN_CHARACTERS = 8_192;
  const MAX_ACCESS_TOKEN_AGE_SECONDS = 3_600;
  const EXPIRY_SAFETY_MS = 5_000;
  const SESSION_KEYS = Object.freeze(['accessToken', 'accessTokenExpiresAt', 'signedInAt']);
  let activeSignIn = null;
  let authGeneration = 0;

  class AlphaAuthError extends Error {
    constructor(code, message) {
      super(message);
      this.name = 'AlphaAuthError';
      this.code = code;
    }
  }

  function base64Url(bytes) {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return globalScope.btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
  }

  function secureRandom(byteLength = 32) {
    const bytes = new Uint8Array(byteLength);
    globalScope.crypto.getRandomValues(bytes);
    return base64Url(bytes);
  }

  async function sha256Base64Url(value) {
    const digest = await globalScope.crypto.subtle.digest(
      'SHA-256',
      new globalScope.TextEncoder().encode(value)
    );
    return base64Url(new Uint8Array(digest));
  }

  function isReservedHostname(hostname) {
    return ['.example', '.invalid', '.test'].some(
      (suffix) => hostname === suffix.slice(1) || hostname.endsWith(suffix)
    );
  }

  function exactHttpsEndpoint(value, label) {
    let parsed;
    try {
      parsed = new URL(value);
    } catch (_error) {
      throw new AlphaAuthError('AUTH_CONFIG', `${label} is not configured.`);
    }
    if (
      parsed.protocol !== 'https:' ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      !parsed.pathname.startsWith('/') ||
      parsed.pathname === '/'
    ) {
      throw new AlphaAuthError('AUTH_CONFIG', `${label} must be one exact HTTPS endpoint.`);
    }
    if (isReservedHostname(parsed.hostname)) {
      throw new AlphaAuthError('AUTH_CONFIG', 'Alpha sign-in is not configured in this build.');
    }
    return parsed.toString();
  }

  function validatedConfiguration() {
    const authorizationEndpoint = exactHttpsEndpoint(
      config.OAUTH_AUTHORIZATION_ENDPOINT,
      'The authorization endpoint'
    );
    const tokenEndpoint = exactHttpsEndpoint(config.OAUTH_TOKEN_ENDPOINT, 'The token endpoint');
    const clientId = String(config.OAUTH_CLIENT_ID || '');
    if (!clientId || clientId.length > 256 || /\s|\.invalid$/iu.test(clientId)) {
      throw new AlphaAuthError('AUTH_CONFIG', 'Alpha sign-in is not configured in this build.');
    }
    const scopes = String(config.OAUTH_SCOPES || '')
      .trim()
      .split(/\s+/u)
      .filter(Boolean);
    if (
      scopes.length < 1 ||
      scopes.length > 20 ||
      scopes.some((scope) => !/^[A-Za-z0-9._~:/-]{1,128}$/u.test(scope)) ||
      scopes.includes('offline_access') ||
      scopes.some((scope) => scope.endsWith('.invalid'))
    ) {
      throw new AlphaAuthError('AUTH_CONFIG', 'Alpha OAuth scopes are not configured safely.');
    }
    return { authorizationEndpoint, tokenEndpoint, clientId, scopes };
  }

  function launchWebAuthFlow(url) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new AlphaAuthError('AUTH_TIMEOUT', 'Sign in timed out. Please try again.'));
      }, AUTH_FLOW_TIMEOUT_MS);

      globalScope.chrome.identity.launchWebAuthFlow({ url, interactive: true }, (redirectUrl) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        const runtimeError = globalScope.chrome.runtime.lastError;
        if (runtimeError) {
          reject(new AlphaAuthError('AUTH_CANCELLED', 'Sign in was cancelled.'));
        } else if (!redirectUrl) {
          reject(new AlphaAuthError('AUTH_CANCELLED', 'Sign in did not complete.'));
        } else {
          resolve(redirectUrl);
        }
      });
    });
  }

  function constantTimeEqual(left, right) {
    if (typeof left !== 'string' || typeof right !== 'string' || left.length !== right.length) {
      return false;
    }
    let difference = 0;
    for (let index = 0; index < left.length; index += 1) {
      difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
    }
    return difference === 0;
  }

  function hasControlCharacters(value) {
    return Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    });
  }

  function parameterCount(parameters, name) {
    return parameters.getAll(name).length;
  }

  function validProviderErrorFields(parameters) {
    const allowed = new Set(['error', 'state', 'error_description', 'error_uri']);
    const keys = Array.from(parameters.keys());
    if (keys.some((key) => !allowed.has(key))) return false;
    if (new Set(keys).size !== keys.length) return false;
    const error = parameters.get('error') || '';
    const description = parameters.get('error_description') || '';
    const errorUri = parameters.get('error_uri') || '';
    if (
      !/^[A-Za-z0-9._~-]{1,128}$/u.test(error) ||
      description.length > 512 ||
      hasControlCharacters(description) ||
      errorUri.length > 2_048 ||
      hasControlCharacters(errorUri)
    ) {
      return false;
    }
    if (errorUri) {
      try {
        const parsed = new URL(errorUri);
        if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return false;
      } catch (_error) {
        return false;
      }
    }
    return true;
  }

  function authorizationCodeFromRedirect(redirectValue, expectedRedirect, expectedState) {
    let redirect;
    try {
      redirect = new URL(redirectValue);
    } catch (_error) {
      throw new AlphaAuthError('AUTH_INVALID_RESPONSE', 'The sign-in response was invalid.');
    }
    const expected = new URL(expectedRedirect);
    if (redirect.origin !== expected.origin || redirect.pathname !== expected.pathname) {
      throw new AlphaAuthError(
        'AUTH_INVALID_RESPONSE',
        'The sign-in redirect did not match Alpha.'
      );
    }
    if (redirect.hash) {
      throw new AlphaAuthError('AUTH_INVALID_RESPONSE', 'Sign-in URL fragments are not accepted.');
    }

    const parameters = redirect.searchParams;
    if (parameterCount(parameters, 'state') !== 1) {
      throw new AlphaAuthError('AUTH_INVALID_RESPONSE', 'The sign-in state was invalid.');
    }
    if (!constantTimeEqual(parameters.get('state'), expectedState)) {
      throw new AlphaAuthError(
        'AUTH_STATE_MISMATCH',
        'Sign in could not be verified. Please try again.'
      );
    }
    if (parameters.has('error')) {
      if (!validProviderErrorFields(parameters)) {
        throw new AlphaAuthError(
          'AUTH_INVALID_RESPONSE',
          'The sign-in error response was invalid.'
        );
      }
      const code = parameters.get('error');
      throw new AlphaAuthError(
        code === 'access_denied' ? 'AUTH_CANCELLED' : 'AUTH_PROVIDER',
        code === 'access_denied'
          ? 'Sign in was cancelled.'
          : 'The identity provider could not complete sign in.'
      );
    }
    const keys = Array.from(parameters.keys());
    if (
      keys.length !== 2 ||
      new Set(keys).size !== 2 ||
      !parameters.has('code') ||
      !parameters.has('state') ||
      parameterCount(parameters, 'code') !== 1
    ) {
      throw new AlphaAuthError('AUTH_INVALID_RESPONSE', 'The sign-in response was invalid.');
    }
    const authorizationCode = parameters.get('code');
    if (
      !authorizationCode ||
      authorizationCode.length > 4_096 ||
      hasControlCharacters(authorizationCode)
    ) {
      throw new AlphaAuthError('AUTH_INVALID_RESPONSE', 'The authorization code was invalid.');
    }
    return authorizationCode;
  }

  async function boundedTokenResponse(response) {
    const contentType = response.headers.get('content-type')?.toLowerCase() || '';
    if (!contentType.includes('application/json')) {
      throw new AlphaAuthError(
        'AUTH_TOKEN_EXCHANGE',
        'The token service returned an invalid response.'
      );
    }
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_TOKEN_RESPONSE_BYTES) {
      throw new AlphaAuthError('AUTH_TOKEN_EXCHANGE', 'The token service response was too large.');
    }
    const reader = response.body?.getReader?.();
    let text = '';
    if (reader) {
      const decoder = new globalScope.TextDecoder();
      let bytes = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_TOKEN_RESPONSE_BYTES) {
          await reader.cancel().catch(() => {});
          throw new AlphaAuthError(
            'AUTH_TOKEN_EXCHANGE',
            'The token service response was too large.'
          );
        }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } else {
      text = await response.text();
      if (new globalScope.TextEncoder().encode(text).byteLength > MAX_TOKEN_RESPONSE_BYTES) {
        throw new AlphaAuthError(
          'AUTH_TOKEN_EXCHANGE',
          'The token service response was too large.'
        );
      }
    }
    try {
      const data = JSON.parse(text);
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('invalid');
      return data;
    } catch (_error) {
      throw new AlphaAuthError('AUTH_TOKEN_EXCHANGE', 'The token service returned invalid JSON.');
    }
  }

  async function exchangeAuthorizationCode({
    tokenEndpoint,
    clientId,
    code,
    verifier,
    redirectUri
  }) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TOKEN_TIMEOUT_MS);
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri
    });
    try {
      const response = await globalScope.fetch(tokenEndpoint, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: body.toString(),
        signal: controller.signal,
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer'
      });
      const data = await boundedTokenResponse(response);
      if (!response.ok) {
        throw new AlphaAuthError(
          'AUTH_TOKEN_EXCHANGE',
          'The identity provider rejected the sign-in exchange.'
        );
      }
      return data;
    } catch (error) {
      if (error instanceof AlphaAuthError) throw error;
      if (error?.name === 'AbortError') {
        throw new AlphaAuthError(
          'AUTH_TIMEOUT',
          'The sign-in exchange timed out. Please try again.'
        );
      }
      throw new AlphaAuthError(
        'AUTH_TOKEN_EXCHANGE',
        'Alpha could not reach the identity provider.'
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  function validatedAccessToken(data) {
    if (Object.hasOwn(data, 'refresh_token')) {
      throw new AlphaAuthError('AUTH_TOKEN_INVALID', 'Refresh tokens are not accepted by Alpha.');
    }
    if (
      Object.hasOwn(data, 'id_token') &&
      (typeof data.id_token !== 'string' ||
        data.id_token.length < 1 ||
        data.id_token.length > 8_192)
    ) {
      throw new AlphaAuthError(
        'AUTH_TOKEN_INVALID',
        'The provider returned an invalid identity token.'
      );
    }
    const token = data.access_token;
    if (
      typeof token !== 'string' ||
      token.length < 20 ||
      token.length > MAX_ACCESS_TOKEN_CHARACTERS ||
      /\s/u.test(token) ||
      hasControlCharacters(token) ||
      String(data.token_type || '').toLowerCase() !== 'bearer'
    ) {
      throw new AlphaAuthError(
        'AUTH_TOKEN_INVALID',
        'The provider returned an invalid access token.'
      );
    }
    const expiresIn =
      typeof data.expires_in === 'string' && /^\d+$/u.test(data.expires_in)
        ? Number(data.expires_in)
        : data.expires_in;
    if (!Number.isInteger(expiresIn) || expiresIn < 1 || expiresIn > MAX_ACCESS_TOKEN_AGE_SECONDS) {
      throw new AlphaAuthError(
        'AUTH_TOKEN_INVALID',
        'The access token lifetime must not exceed one hour.'
      );
    }
    return { token, expiresIn };
  }

  async function performSignIn() {
    const generation = ++authGeneration;
    const provider = validatedConfiguration();
    const redirectUri = globalScope.chrome.identity.getRedirectURL(config.OAUTH_REDIRECT_PATH);
    const verifier = secureRandom(32);
    const state = secureRandom(32);
    const challenge = await sha256Base64Url(verifier);
    const authorizationUrl = new URL(provider.authorizationEndpoint);
    authorizationUrl.search = new URLSearchParams({
      response_type: 'code',
      client_id: provider.clientId,
      redirect_uri: redirectUri,
      scope: provider.scopes.join(' '),
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256'
    }).toString();

    const redirect = await launchWebAuthFlow(authorizationUrl.toString());
    const code = authorizationCodeFromRedirect(redirect, redirectUri, state);
    const tokenResponse = await exchangeAuthorizationCode({
      tokenEndpoint: provider.tokenEndpoint,
      clientId: provider.clientId,
      code,
      verifier,
      redirectUri
    });
    const { token, expiresIn } = validatedAccessToken(tokenResponse);
    if (generation !== authGeneration) {
      throw new AlphaAuthError('AUTH_CANCELLED', 'Sign in was cancelled.');
    }
    const signedInAt = Date.now();
    const accessTokenExpiresAt = signedInAt + expiresIn * 1_000;
    await sessionSet({ accessToken: token, accessTokenExpiresAt, signedInAt });
    if (generation !== authGeneration) {
      await sessionRemove(SESSION_KEYS);
      throw new AlphaAuthError('AUTH_CANCELLED', 'Sign in was cancelled.');
    }
    return { signedIn: true, accessTokenExpiresAt };
  }

  function signIn() {
    if (activeSignIn) return activeSignIn;
    activeSignIn = performSignIn().finally(() => {
      activeSignIn = null;
    });
    return activeSignIn;
  }

  async function signOut() {
    authGeneration += 1;
    await sessionRemove(SESSION_KEYS);
    return { signedIn: false };
  }

  async function getSession({ required = false } = {}) {
    const session = await sessionGet({
      accessToken: '',
      accessTokenExpiresAt: 0,
      signedInAt: 0
    });
    const valid =
      typeof session.accessToken === 'string' &&
      session.accessToken.length >= 20 &&
      Number.isFinite(session.accessTokenExpiresAt) &&
      session.accessTokenExpiresAt > Date.now() + EXPIRY_SAFETY_MS &&
      session.accessTokenExpiresAt <= Date.now() + MAX_ACCESS_TOKEN_AGE_SECONDS * 1_000;
    if (!valid) {
      const hadSession = Boolean(
        session.accessToken || session.accessTokenExpiresAt || session.signedInAt
      );
      if (hadSession) {
        await sessionRemove(SESSION_KEYS);
      }
      if (required) {
        throw new AlphaAuthError(
          hadSession ? 'AUTH_EXPIRED' : 'AUTH_REQUIRED',
          hadSession
            ? 'Your Alpha session expired. Sign in again from the extension menu.'
            : 'Sign in from the Alpha extension menu to continue.'
        );
      }
      return { signedIn: false, accessToken: '', accessTokenExpiresAt: 0 };
    }
    return {
      signedIn: true,
      accessToken: session.accessToken,
      accessTokenExpiresAt: session.accessTokenExpiresAt
    };
  }

  async function status() {
    const session = await getSession();
    return {
      signedIn: session.signedIn,
      accessTokenExpiresAt: session.accessTokenExpiresAt || null
    };
  }

  globalScope.AlphaAuth = Object.freeze({
    AlphaAuthError,
    AUTH_FLOW_TIMEOUT_MS,
    MAX_ACCESS_TOKEN_AGE_SECONDS,
    authorizationCodeFromRedirect,
    boundedTokenResponse,
    getSession,
    signIn,
    signOut,
    status,
    validatedAccessToken
  });
})(globalThis);
