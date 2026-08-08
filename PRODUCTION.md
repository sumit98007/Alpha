# Alpha production deployment

## Required gateway configuration

Set these environment variables on the backend host:

- `NODE_ENV=production`
- `HOST=0.0.0.0`
- `PORT=3000` (or the port supplied by the hosting platform)
- `GEMINI_API_KEY`
- `GATEWAY_API_KEY` (a long random value shared with the extension)
- `ALLOWED_ORIGINS=chrome-extension://<published-extension-id>`
- `ENABLE_SEMANTIC_CACHE=false` unless cache entries are isolated by authenticated user

Redis is strongly recommended for multi-instance deployments:

- `REDIS_URL=rediss://...`

The remaining limits and model settings are documented in `backend/.env.example`.

## Release procedure

1. Run `npm ci && npm test` inside `backend`.
2. Build and deploy `backend/Dockerfile` behind HTTPS.
3. Set the HTTPS gateway URL and matching gateway API key in the extension Settings page.
4. Confirm Settings reports the authenticated readiness endpoint as online.
5. Load the unpacked extension for a smoke test on each supported site before submitting the same directory to the browser store.

Never embed `GEMINI_API_KEY` in the extension. Rotate `GATEWAY_API_KEY` if an extension installation or shared machine is compromised.

`GATEWAY_API_KEY` is suitable only for a private/internal distribution because any credential shipped to a public browser client can ultimately be extracted. A public release must replace the shared key with short-lived, per-user tokens issued by an authentication service. Keep provider quotas and billing alerts enabled even when authentication and rate limiting are active.
