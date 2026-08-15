# Alpha API authentication boundary

The public Alpha API accepts short-lived per-user bearer tokens. It does not accept website session cookies, Sites platform identity headers, or a credential bundled into the browser extension.

## Extension token acquisition

The browser extension must obtain an access token from a dedicated authentication flow before calling the API, then send it as:

```http
Authorization: Bearer <access-token>
```

Token acquisition is deliberately outside this backend gateway. The extension implements OAuth 2.0 Authorization Code with PKCE (`S256`) for a public browser client, using Chrome’s fixed redirect URI. The release package fixes the authorization endpoint, token endpoint, client ID, and minimal scopes at build time. No client secret, implicit-flow token, refresh token, or token in a redirect URL is accepted.

The marketing/account website's ChatGPT/Sites identity headers are server-side website signals. A Chrome extension cannot safely copy or rely on those headers. If website sign-in is used to initiate extension linking, the handoff must be a one-time, expiring code redeemed by the extension—not a website cookie or long-lived token in a URL.

Do not place the Gemini key, an OIDC client secret, a shared gateway key, or a refresh token in distributable extension source. Alpha keeps a bounded, short-lived access token only in `chrome.storage.session`; sign-out removes it and browser restart clears the session. The production identity provider must prevent new tokens for suspended accounts and expire access tokens within one hour.

## Required production issuer configuration

Configure all of the following:

- `AUTH_JWKS_URI`: HTTPS JWKS endpoint for signing-key rotation.
- `AUTH_ISSUER`: exact expected `iss` claim.
- `AUTH_AUDIENCE`: required Alpha API audience.
- `AUTH_REQUIRED_SCOPES`: comma-separated authorization scopes every API access token must grant (for example, `alpha.api`).
- `AUTH_ALGORITHMS`: asymmetric algorithms accepted from the issuer; default `RS256`.
- `AUTH_MAX_TOKEN_AGE_SECONDS`: maximum lifetime and age, capped at one hour in production.
- `AUTH_CLOCK_TOLERANCE_SECONDS`: small clock-skew allowance.

Accepted tokens must have a verified signature; valid `iss`, `sub`, `aud`, `iat`, and `exp` claims; and every configured API scope in the standard space-delimited `scope` claim. The API rejects unsigned tokens, symmetric algorithms, stale tokens, excessive lifetimes, tokens without the Alpha API scope, unknown signing keys, and unsupported critical JOSE extensions. Authentication failures return one generic response.

`GATEWAY_API_KEY` and `ALLOW_LEGACY_GATEWAY_KEY=true` are supported only for local/private development. The server refuses to start with legacy key authentication in production.

## Quotas and revocation

Authenticated subject IDs drive per-user, per-endpoint rate limits and daily quotas. Source IP is an additional abuse signal, not identity. Production requires `TRAFFIC_REDIS_URL` (or `REDIS_URL`) so limits apply across all instances and a secret-manager `TRAFFIC_KEY_SECRET`. Redis receives only secret-keyed HMAC identifiers plus counters: short-window rate entries expire with `RATE_LIMIT_WINDOW_MS`, and daily quota entries expire within 24 hours. Default request logging is disabled so raw IP addresses are not emitted by Fastify.

JWT verification alone does not provide immediate revocation for an already-issued token. Keep access tokens short-lived. The future authentication service must enforce disabled accounts and revoked refresh sessions before issuing another token. If immediate access-token revocation is required, add an issuer-backed introspection or deny-list check with a bounded cache.
