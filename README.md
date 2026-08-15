# Alpha

Alpha is a privacy-first Chrome extension that turns rough text into a concise, professional prompt inside ChatGPT, Claude, and Gemini. Its movable launcher transforms into a floating review window, protects recognised sensitive values locally, and lets the user copy, retry, or place the result without automatically sending anything.

## Release status

This repository is a production release candidate, not an already-published service. The product code, authenticated gateway boundary, deterministic Chrome packaging, product website, account surface, and automated quality gates are implemented. Public release still requires production identity-provider configuration, a deployed HTTPS gateway and Redis, a final Chrome extension ID, approved public legal/support details, and store-publisher approval. See [UPGRADES.md](UPGRADES.md) for the exact sign-off register.

## Repository map

| Path                 | Purpose                                                                              |
| -------------------- | ------------------------------------------------------------------------------------ |
| `extension/`         | Manifest V3 browser runtime and floating prompt UI                                   |
| `backend/`           | Fastify gateway, JWT verification, traffic policy, Gemini integration, and API tests |
| `website/`           | Product, trust, support, terms, and Sign in with ChatGPT account surfaces            |
| `scripts/`           | Deterministic extension packaging and independent verification                       |
| `quality-tests/`     | Chrome manifest, archive, permission, and icon policy tests                          |
| `evaluation/`        | Versioned synthetic prompt-quality and adversarial evaluation cases                  |
| `DESIGN_LANGUAGE.md` | Alpha palette, Boldonse typography, components, motion, and accessibility            |
| `PRODUCTION.md`      | Environment and deployment runbook                                                   |
| `CHROME_RELEASE.md`  | Chrome package and Web Store release procedure                                       |

## Prerequisites

- Node.js 24 LTS; `.nvmrc` pins the CI release.
- npm with lockfile installs.
- Docker only when building the gateway container.

## Verify everything

Install each workspace, then run the repository quality gate:

```sh
npm ci
npm ci --prefix backend
npm ci --prefix website
npm run check
```

The gate lints and formats release code, builds and tests the gateway and website, audits production dependencies, and creates and independently verifies a deterministic CI extension package.

Hosted-model quality is a separate release gate. Run the authenticated, cache-bypassing synthetic suite and complete its manual rubric as documented in [PROMPT_EVALUATION.md](PROMPT_EVALUATION.md); provider behavior is not inferred from mocks alone.

## Local development

Gateway:

```sh
cp backend/.env.example backend/.env
# Then replace GEMINI_API_KEY and GATEWAY_API_KEY with private development values.
npm run dev --prefix backend
```

Keep `NODE_ENV=development` and use a development-only gateway key solely for private local testing. Production startup rejects shared-key authentication.

Website:

```sh
npm run dev --prefix website
```

Extension UI:

1. Open `chrome://extensions` and enable Developer mode.
2. Load `extension/` once as an unpacked extension.
3. After source changes, use the extension card’s reload control and refresh the AI tab; do not repeatedly unpack the directory.

The development manifest intentionally points to a non-routable API placeholder. End-to-end extension testing uses a package built for an authenticated HTTPS staging origin.

## Security boundary

- Gemini credentials exist only in the gateway environment.
- Public clients use short-lived per-user bearer tokens; a credential embedded in a distributable extension is never considered secret.
- Chat context is off by default and requires separate consent.
- When local protection is enabled and a supported pattern is detected, the value is replaced on-device with a request-scoped placeholder; only prompt-owned values can be restored locally after integrity checks.
- Production traffic limits and quotas require Redis and fail closed when their distributed store is unavailable.
- Production rejects server-side semantic similarity caching. After a successful refinement, the retry base and exact matching result are page-local and memory-only; the lookup key is a SHA-256 fingerprint rather than raw prompt or chat text.

See [backend/AUTHENTICATION.md](backend/AUTHENTICATION.md) for the identity handoff and [extension/privacy.html](extension/privacy.html) for the in-product disclosure.
