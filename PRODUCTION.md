# Alpha production deployment

This runbook describes the production release candidate. Do not publish the API or Chrome package until every external gate in `UPGRADES.md` is complete.

## Architecture and trust boundary

- The Chrome extension sends approved prompt data to one fixed HTTPS Alpha API origin, applying supported local protection first when the user keeps it enabled.
- The extension authenticates each request with a short-lived, per-user bearer token obtained through OAuth 2.0 Authorization Code with PKCE. It contains no OAuth client secret, Gemini key, shared gateway key, or long-lived refresh token.
- The gateway verifies asymmetric JWTs against the configured HTTPS JWKS endpoint before applying per-user quotas and calling Gemini.
- The hosted website account session is separate. Sites identity headers or cookies must never be copied into the extension. If the website later initiates account linking, use a single-use, expiring broker code.
- Prompt and chat content must not appear in application logs, analytics, error trackers, or URL parameters.

See `backend/AUTHENTICATION.md` for the full authentication contract and `CHROME_RELEASE.md` for deterministic packaging policy.

## Runtime requirements

- Node.js 24.18.1, matching `.nvmrc` and CI.
- An HTTPS API hostname behind a proxy with known IP/CIDR ranges.
- A TLS Redis service for distributed rate limits and quotas.
- A production identity provider that supports public browser clients, Authorization Code with PKCE, short-lived JWT access tokens, and JWKS rotation.
- A Gemini API project with quotas, budget alerts, and a server-side key.
- A secret manager for all production credentials. Do not store production secrets in `.env` files, the repository, image layers, CI logs, browser storage, or deployment metadata.

## Required gateway configuration

Start from `backend/.env.example` and set at least:

```dotenv
NODE_ENV=production
HOST=0.0.0.0
PORT=3000

GEMINI_API_KEY=<secret-manager-reference>
GEMINI_MODEL=gemini-3.5-flash-lite
GEMINI_EMBEDDING_MODEL=gemini-embedding-2

AUTH_JWKS_URI=https://identity.example.com/.well-known/jwks.json
AUTH_ISSUER=https://identity.example.com/
AUTH_AUDIENCE=alpha-api
AUTH_REQUIRED_SCOPES=alpha.api
AUTH_ALGORITHMS=RS256
AUTH_MAX_TOKEN_AGE_SECONDS=3600

TRAFFIC_REDIS_URL=rediss://redis.example.com:6380
TRAFFIC_KEY_SECRET=<secret-manager-reference>
ALLOWED_ORIGINS=chrome-extension://<published-extension-id>
TRUST_PROXY=<exact-proxy-ip-or-cidr-list>
ENABLE_SEMANTIC_CACHE=false
```

Production startup deliberately fails when authentication, an exact allowed origin, Gemini credentials, or distributed traffic storage is missing. It also fails when:

- `GATEWAY_API_KEY` or `ALLOW_LEGACY_GATEWAY_KEY=true` is present;
- Redis does not use `rediss://`;
- CORS contains a wildcard, path, credentials, or non-HTTPS web origin;
- `TRUST_PROXY` contains `true`, a named alias, an unspecified address, a trust-all `/0` range, a malformed entry, or anything other than an explicit deployment-approved IP/CIDR; or
- bearer-token lifetime exceeds one hour.

Pin an exact stable Gemini model identifier; do not use a hot-swapped `latest` alias or a preview model without a new quality and availability review. On every release day, confirm the configured identifiers against Google’s [official model list](https://ai.google.dev/gemini-api/docs/models) and [deprecation schedule](https://ai.google.dev/gemini-api/docs/deprecations), then run the live evaluation against that exact model. The identifiers above were rechecked on 11 August 2026.

Gateway prompt output and custom-guidance limits are capped at the extension’s corresponding 30,000- and 2,000-character limits. Treat these values as a shared API contract; widening either side requires a coordinated client/server release and compatibility tests.

Production rejects semantic similarity caching because a merely similar prompt could contain changed facts and must receive a fresh result. After a successful refinement, the extension retains the retry base and exact matching result only in current-page extension-frame memory; its lookup key is a SHA-256 fingerprint rather than raw prompt or chat text. Failure or cancellation clears the retry base, and tab reload/close clears page memory. Any future server-cache design requires exact content binding, user isolation, an approved retention period, and new security tests before this guard may be changed.

Default per-request logging is disabled so Fastify does not emit raw client IPs. Rate limiting still processes the source IP and authenticated subject, but production stores only secret-keyed HMAC identifiers and counters in Redis. Rate keys expire with the configured short rate window; quota keys expire within 24 hours. Rotate `TRAFFIC_KEY_SECRET` through the secret manager; rotation intentionally resets existing counters.

## Identity-provider configuration

Register Alpha as a public client: no client secret and no implicit grant. Configure the redirect URI returned by Chrome for the published extension ID, exact authorization and token endpoints, the `alpha-api` audience, and only `openid` plus the required Alpha API authorization scope. Require PKCE with `S256`.

Access tokens must be signed JWTs accepted by the gateway issuer/audience/algorithm policy, include the configured `alpha.api` authorization scope, and expire within one hour. The extension keeps the token only in `chrome.storage.session`; signing out or browser restart removes the local token, and expiry prevents further API calls. Do not issue or return refresh tokens to the extension.

Offline JWKS verification cannot revoke an already issued bearer before `exp`. The accepted maximum revocation window is therefore the configured access-token lifetime (never more than one hour); use a shorter issuer lifetime where usability allows. Account suspension and session revocation must prevent issuance of another token. If immediate revocation becomes a requirement, add a fail-closed issuer introspection or distributed deny-list check before release and update the readiness/latency budget.

Before release, prove all of these cases: successful sign-in, cancelled sign-in, state mismatch, code-reuse rejection, wrong issuer/audience/scope, expired token, a disabled account being unable to obtain a new token, local sign-out, expiry within the accepted revocation window, and signing-key rotation.

## Deploy and verify the gateway

1. Install and test with the pinned runtime:

   ```sh
   npm ci --prefix backend
   npm test --prefix backend
   npm audit --prefix backend --omit=dev --audit-level=high
   ```

2. Build `backend/Dockerfile`, retain the resulting image digest, and scan the image. The same pinned Node base is used for build and runtime stages.
3. Deploy behind HTTPS with secrets injected by the host and the final proxy/CORS configuration.
4. Confirm `/api/health` is reachable without authentication and reveals no dependency details.
5. Confirm `/api/ready` requires a valid user token and reports ready only when JWKS, Redis, the disabled server-cache policy, and Gemini are healthy.
6. Exercise authenticated enhancement requests plus the 400, 401, 413, 415, 429, 503, and timeout paths. Verify responses and structured logs contain no prompt, chat, authorization, source-IP, provider, or secret material. Inspect actual production log samples, not only logger configuration.
7. Run the cache-bypassing deployed-model suite in `PROMPT_EVALUATION.md` and complete its manual rubric for the exact model and gateway image being released.

## Build and test the Chrome package

Run the complete repository gate, then package with the deployed API origin and the selected public-client OAuth configuration as described by `npm run package:extension -- --help` and `CHROME_RELEASE.md`:

```sh
npm ci
npm ci --prefix backend
npm ci --prefix website
npm run check
ALPHA_API_ORIGIN=https://api.your-domain.com npm run package:extension -- <oauth-build-options>
```

Keep the printed SHA-256 checksum. Load that exact ZIP through a private or trusted-tester Chrome Web Store release; do not upload the source directory or modify the verified archive. Test sign-in and refinement on current ChatGPT, Claude, and Gemini layouts before widening distribution.

## Website and publication

Keep the Sites deployment private until the support contact, legal entity, retention language, provider terms, and Web Store disclosures have been approved. Website sign-in establishes only the hosted account session until an explicitly reviewed one-time-code account-linking flow is deployed.

Publishing, DNS changes, production secret creation, store submission, and making the website public are external actions requiring owner approval.

## Operations and rollback

- Alert on latency, provider failures, authentication failures, quota pressure, Redis health, and deployment errors without recording user content.
- Set provider and infrastructure budget alerts and conservative initial quotas.
- Maintain documented incident response, account deletion, token/key rotation, dependency update, and support ownership.
- Roll back by deployed image digest and the retained Chrome package/version. Chrome versions cannot be reused; ship a higher version for a corrected package.
- Re-run `npm run check` and the authenticated smoke suite after every runtime, model, dependency, origin, permission, or identity configuration change.
