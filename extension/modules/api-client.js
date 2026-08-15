(function initializeAlphaApi(globalScope) {
  'use strict';

  const controllers = new Map();
  const DEFAULT_TIMEOUT_MS = 28_000;
  const MAX_RESPONSE_BYTES = 256_000;

  class AlphaApiError extends Error {
    constructor(code, message, status = null) {
      super(message);
      this.name = 'AlphaApiError';
      this.code = code;
      this.status = status;
    }
  }

  function safeGatewayOrigin(value) {
    let url;
    try {
      url = new URL(value);
    } catch (_error) {
      throw new AlphaApiError('CONFIGURATION', 'Alpha is not configured correctly.');
    }
    if (url.protocol !== 'https:') {
      throw new AlphaApiError('CONFIGURATION', 'Alpha requires a secure gateway connection.');
    }
    return url.origin;
  }

  function responseError(status) {
    if (status === 401 || status === 403) {
      return new AlphaApiError('AUTH', 'Your Alpha session has expired. Sign in again.', status);
    }
    if (status === 408 || status === 504) {
      return new AlphaApiError('TIMEOUT', 'Alpha took too long to respond. Try again.', status);
    }
    if (status === 413) {
      return new AlphaApiError('TOO_LARGE', 'This prompt is too large to refine safely.', status);
    }
    if (status === 429) {
      return new AlphaApiError(
        'RATE_LIMIT',
        'You have reached the current Alpha usage limit.',
        status
      );
    }
    if (status >= 500) {
      return new AlphaApiError(
        'SERVICE',
        'Alpha is temporarily unavailable. Try again shortly.',
        status
      );
    }
    return new AlphaApiError('REQUEST', 'Alpha could not process this request.', status);
  }

  async function readBoundedText(response) {
    const reader = response.body?.getReader?.();
    if (!reader) {
      const text = await response.text();
      if (new globalScope.TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) {
        throw new AlphaApiError('INVALID_RESPONSE', 'Alpha returned an oversized response.');
      }
      return text;
    }

    const decoder = new globalScope.TextDecoder();
    let byteCount = 0;
    let text = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteCount += value.byteLength;
      if (byteCount > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        throw new AlphaApiError('INVALID_RESPONSE', 'Alpha returned an oversized response.');
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  }

  async function requestJson({
    baseUrl,
    path,
    method = 'GET',
    headers = {},
    body,
    requestId,
    timeoutMs = DEFAULT_TIMEOUT_MS
  }) {
    const origin = safeGatewayOrigin(baseUrl);
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    if (requestId) controllers.set(requestId, controller);

    try {
      const response = await fetch(`${origin}${path}`, {
        method,
        headers: {
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...headers
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error'
      });

      if (response.redirected) {
        throw new AlphaApiError('INVALID_RESPONSE', 'Alpha rejected an unexpected redirect.');
      }
      if (response.url) {
        let responseOrigin;
        try {
          responseOrigin = new URL(response.url).origin;
        } catch (_error) {
          throw new AlphaApiError('INVALID_RESPONSE', 'Alpha returned an invalid response URL.');
        }
        if (responseOrigin !== origin) {
          throw new AlphaApiError(
            'INVALID_RESPONSE',
            'Alpha rejected an unexpected response origin.'
          );
        }
      }
      if (!response.ok) throw responseError(response.status);
      const contentType = response.headers?.get?.('content-type') || '';
      if (!contentType.toLowerCase().includes('application/json')) {
        throw new AlphaApiError('INVALID_RESPONSE', 'Alpha returned an invalid response.');
      }
      const declaredLength = Number(response.headers?.get?.('content-length'));
      if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
        throw new AlphaApiError('INVALID_RESPONSE', 'Alpha returned an oversized response.');
      }
      const responseText = await readBoundedText(response);
      try {
        return JSON.parse(responseText);
      } catch (_error) {
        throw new AlphaApiError('INVALID_RESPONSE', 'Alpha returned invalid JSON.');
      }
    } catch (error) {
      if (error instanceof AlphaApiError) throw error;
      if (error?.name === 'AbortError') {
        throw timedOut
          ? new AlphaApiError('TIMEOUT', 'Alpha took too long to respond. Try again.')
          : new AlphaApiError('CANCELLED', 'The refinement was cancelled.');
      }
      throw new AlphaApiError(
        'NETWORK',
        'Alpha cannot reach its service. Check your connection and try again.'
      );
    } finally {
      clearTimeout(timeout);
      if (requestId && controllers.get(requestId) === controller) controllers.delete(requestId);
    }
  }

  function cancel(requestId) {
    const controller = controllers.get(requestId);
    if (!controller) return false;
    controller.abort();
    controllers.delete(requestId);
    return true;
  }

  globalScope.AlphaApi = Object.freeze({
    AlphaApiError,
    MAX_RESPONSE_BYTES,
    cancel,
    requestJson,
    safeGatewayOrigin
  });
})(globalThis);
