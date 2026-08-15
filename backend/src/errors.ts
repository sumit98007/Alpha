export type ApiErrorCode =
  | 'AUTHENTICATION_REQUIRED'
  | 'INVALID_REQUEST'
  | 'NOT_FOUND'
  | 'PAYLOAD_TOO_LARGE'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_UNAVAILABLE'
  | 'QUOTA_EXCEEDED'
  | 'RATE_LIMITED'
  | 'SERVICE_UNAVAILABLE'
  | 'UNSUPPORTED_MEDIA_TYPE';

export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: ApiErrorCode,
    message: string,
    public readonly retryAfterSeconds?: number
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export class ProviderError extends Error {
  constructor(
    public readonly kind: 'timeout' | 'unavailable',
    public readonly causeName = 'Error'
  ) {
    super(kind === 'timeout' ? 'The provider request timed out.' : 'The provider is unavailable.');
    this.name = 'ProviderError';
  }
}

export function mapProviderError(error: unknown): ProviderError {
  const value = error as { name?: string; code?: string; status?: number } | undefined;
  const name = value?.name || 'Error';
  const code = value?.code || '';
  const status = value?.status;
  if (
    name === 'AbortError' ||
    name === 'TimeoutError' ||
    code === 'ETIMEDOUT' ||
    code === 'UND_ERR_CONNECT_TIMEOUT'
  ) {
    return new ProviderError('timeout', name);
  }
  if (
    typeof status === 'number' &&
    status >= 400 &&
    status < 500 &&
    status !== 408 &&
    status !== 429
  ) {
    // Provider-side client errors are deliberately collapsed so provider details never cross the API boundary.
    return new ProviderError('unavailable', name);
  }
  return new ProviderError('unavailable', name);
}
