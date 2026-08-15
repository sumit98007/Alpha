# Alpha upgrade register

This document separates implemented product work from the external release steps that still require production accounts, credentials, or explicit publication approval.

## Implemented in this release candidate

### Floating product experience

- The launcher is a draggable bubble that stays within the active viewport and can be reset beside the current composer.
- The result and consent surfaces morph out of the bubble, remain draggable, scroll within constrained viewports, and collapse back to the launcher.
- Resizing, scrolling, and replacement of the host composer trigger automatic re-anchoring.
- Keyboard movement, focus trapping, Escape-to-collapse, reduced-motion support, accessible labels, and visible focus states are included.
- “Try again” always requests a fresh result. After success, the base prompt and matching result remain only in the current page’s extension-frame memory; closing and reopening reuses the result, while a changed base prompt or relevant preference creates a new SHA-256 cache fingerprint. Failure or cancellation clears the retry base, and tab reload/close clears page memory.
- “Copy” and “Use prompt” remain explicit actions; Alpha never submits the prompt to the host AI service.

### Prompt quality and context

- Refinement modes now target the minimum sufficient prompt instead of expanding every request mechanically.
- The system instruction preserves user intent and voice, treats context and guidance as untrusted data, avoids invented facts, and adds structure or verification only when useful.
- A versioned synthetic evaluation suite checks deployed-model fact preservation, context fidelity, injection resistance, placeholder integrity, output bounds, and expansion efficiency without logging prompt or result content.
- Recent visible chat context is capped, locally protected, and off by default.
- Prompt, context, and custom-guidance data have distinct protection ownership so only prompt-origin values can be restored into a result.
- ChatGPT, Claude, and Gemini use isolated platform adapters for composer detection, context collection, and safe insertion.

### Privacy and sensitive-data controls

- First-use prompt consent appears before Alpha reads or transmits composer text. Recent-chat processing has a separate consent record that is checked before recent visible messages are read.
- The extension explains exactly what is transmitted, the limits of pattern detection, the downstream Gemini processor, and what happens when restored values are inserted into a host composer.
- When protection is enabled and a supported pattern is detected, request-scoped, cryptographically random placeholders replace the value on-device; automated detection can miss sensitive data.
- Placeholder ownership, request ID, occurrence count, order, and semantic anchors are checked before local restoration. Integrity failure returns the original prompt rather than risking misplaced sensitive data. Unprotected or undetected text may be reproduced in the result.
- Provider credentials remain server-side. The extension contains no Gemini key or production shared gateway key.
- Context and guidance secrets are never hydrated into the refined prompt.

### API gateway and abuse guardrails

- Public architecture uses short-lived, per-user JWT bearer tokens verified against an HTTPS JWKS endpoint with strict issuer, audience, age, algorithm, key, and claim checks.
- Legacy shared-key authentication is restricted to local/private development and makes production startup fail.
- Request schemas reject unknown fields, malformed placeholder contracts, oversized bodies, unsupported media types, and invalid platform or preference values.
- Provider calls have bounded timeouts, retry counts, output tokens, and output characters. Client cancellation propagates to in-flight work.
- Per-IP, per-user, per-endpoint, and daily quotas fail closed through a distributed Redis policy store in production.
- Default request logging is disabled. Redis limiter keys use secret-keyed HMAC identifiers rather than raw IP/account values and expire with the rate or 24-hour quota window.
- Production rejects server-side semantic similarity caching. The latest successful base prompt and exact matching result are retained only in current-page extension-frame memory, with a SHA-256 lookup key, so any changed prompt reaches the provider.
- Production CORS uses exact HTTPS or published Chrome-extension origins; wildcard origins and implicit proxy trust are rejected.
- Responses include restrictive security and no-store headers. Logs redact authorization material and avoid prompt or chat content.
- The runtime container uses an unprivileged user and a pinned Node 24 Alpine image digest.

### Chrome release engineering

- The developer settings page and broad optional host access have been removed.
- Production packages derive one fixed HTTPS API origin at build time and exclude localhost, reserved development hosts, shared-key code, the legacy developer gateway/options page, tests, maps, environment files, and key material.
- Reviewed 16, 32, 48, and 128 pixel icons are included from a code-owned Alpha brand source.
- Packaging is deterministic and independently verifies paths, CRCs, permissions, referenced assets, icon dimensions, CSP assumptions, and forbidden runtime strings.
- CI runs locked installs, linting, formatting, backend and website builds/tests, production audits, and the deterministic package check on Node 24.

### Brand, website, and account surface

- `DESIGN_LANGUAGE.md` is the source of truth for the black, deep-blue, orange, and grey palette, Boldonse display typography, spacing, motion, accessibility, and component rules.
- The responsive website includes product, privacy, security, terms, support, and account routes plus a live bubble-to-window demonstration.
- Boldonse and its license are bundled locally; the site does not depend on a remote font service.
- The account route uses the hosting platform’s Sign in with ChatGPT flow. Alpha does not receive or store a password.
- A production social-preview image and branded favicon are included.
- The website source is built, type-checked, route-tested, and production-dependency audited. Its existing private owner-review deployment must be refreshed from this release candidate before sign-off.

## Required before public API and Chrome Web Store release

These are release gates, not TODOs that can be safely guessed in source code.

1. **Configure the production identity provider.** Choose an OIDC provider compatible with Alpha’s implemented Authorization Code + PKCE public-client flow. Register the final Chrome redirect URI and minimal `openid alpha.api` scopes; configure issuer, audience, JWKS, client ID, access-token lifetime, account suspension, deletion, and token-endpoint CORS without a client secret or refresh token. Extension sign-out is local; an already issued token can remain valid only until its expiry, capped at one hour, unless an explicitly tested revocation mechanism is added.
2. **Deploy the gateway.** Provision the Gemini key, HTTPS API hostname, distributed Redis, traffic-identifier HMAC secret, authentication variables, trusted proxy CIDRs, quotas, provider budget alerts, and secret rotation. Set CORS to the final 32-character Chrome extension ID.
3. **Validate the packaged identity flow.** Build with the registered provider endpoints, public client ID, minimal scopes, and deployed API origin. Verify success, cancellation, state/redirect rejection, expiry, local sign-out, disabled-account reauthentication failure, and the documented revocation window using the exact package.
4. **Complete manual host smoke tests.** Test the packaged build—not an edited unpacked directory—against current ChatGPT, Claude, and Gemini layouts at desktop, narrow-window, zoomed, dark, light, keyboard-only, offline, timeout, expired-session, and rate-limit states.
5. **Run the live prompt evaluation.** Execute `PROMPT_EVALUATION.md` against the deployed model, pass every automated invariant, complete the manual rubric, and retain the model/release evidence without adding prompt content to general logs.
6. **Complete publication review.** Obtain counsel review of terms and privacy text, add a real support/contact channel and legal entity details, make the approved website/privacy URL public, and confirm Google Gemini data-retention terms match the disclosure.
7. **Prepare store operations.** Use the verified publisher account, final extension ID, version increment, listing copy, screenshots, promotional tiles, single-purpose and permission justifications, data-use declarations, tester rollout, rollback plan, and retained package checksum.
8. **Add production operations.** Configure metrics and alerts for latency, provider failures, authentication failures, quota pressure, Redis health, and deployment errors without logging prompt content. Define incident response, data requests, key rotation, dependency updates, and backup/restore ownership.

## Evidence required for release sign-off

- Root, backend, and website verification commands pass from clean locked installs on Node 24.
- Production dependency audits report no known high-severity vulnerabilities.
- The final extension ZIP passes the independent package verifier and its SHA-256 checksum is recorded.
- A real short-lived user token can reach authenticated readiness and refinement endpoints; missing, expired, wrong-audience, and wrong-scope tokens fail closed. Local sign-out removes the session token, disabled accounts cannot obtain another token, and any bearer issued before revocation expires within the documented one-hour maximum window.
- The deployed gateway and private website pass smoke tests without secrets, prompt text, or authorization values appearing in logs.
- The versioned live prompt evaluation passes automated thresholds and its manual quality rubric for the exact deployed model and gateway image.
- Store disclosures, the in-extension privacy notice, and the public website describe the same data flow.
