# Alpha Chrome release process

Alpha deliberately uses two extension configurations:

- `extension/` is the development source loaded from `chrome://extensions`. It contains only the
  deliberately non-routable API, OAuth endpoint, public-client, and scope placeholders listed
  below.
- The production manifest exists only inside the generated ZIP. The packaging command derives it
  from the development manifest, embeds the reviewed release configuration, removes developer-only
  access, and grants host access only to the API and OAuth token endpoint origins. ChatGPT, Claude,
  and Gemini remain limited separately by the content-script and web-accessible-resource match
  lists.

The five reviewed source placeholders are:

```text
https://api.alpha.invalid
https://auth.alpha.invalid/oauth2/authorize
https://auth.alpha.invalid/oauth2/token
alpha-extension-client.invalid
openid alpha.api.invalid
```

Do not upload the `extension` source directory directly to the Chrome Web Store.

## Build the store package

Use the repository CI runtime, Node.js 24.18.1, and install locked dependencies once:

```sh
npm ci
```

Generate a package for the deployed API and the identity provider's registered public browser
client. The authorization and token values are exact endpoints, not issuer origins; the scope value
is one quoted, space-delimited string:

```sh
ALPHA_API_ORIGIN=https://api.your-domain.com \
ALPHA_OAUTH_AUTHORIZATION_ENDPOINT=https://identity.your-domain.com/oauth2/authorize \
ALPHA_OAUTH_TOKEN_ENDPOINT=https://identity.your-domain.com/oauth2/token \
ALPHA_OAUTH_CLIENT_ID=replace-with-provider-client-id \
ALPHA_OAUTH_SCOPES="openid alpha.api" \
  npm run package:extension
```

The command writes `artifacts/alpha-extension-<version>.zip`, prints its SHA-256 checksum, and then
reads the archive back through the independent verifier. To choose a different output path:

```sh
npm run package:extension -- \
  --api-origin=https://api.your-domain.com \
  --oauth-authorization-endpoint=https://identity.your-domain.com/oauth2/authorize \
  --oauth-token-endpoint=https://identity.your-domain.com/oauth2/token \
  --oauth-client-id=replace-with-provider-client-id \
  --oauth-scopes="openid alpha.api" \
  --output=artifacts/alpha-extension-release.zip
```

Replace every illustrative value with the deployed, provider-registered configuration. Release
builds reject local or reserved endpoint hosts and placeholder client/scope values. The CI-only
`--verify-only` switch permits `.example` API, provider, client, and scope values; it never permits
the source `.invalid` placeholders.

Given identical tracked inputs and the same five build values, packaging produces byte-identical
ZIPs. ZIP entries are sorted, use a fixed timestamp, contain no platform metadata, and are
CRC-checked.

## Enforced production policy

The build fails unless all of these conditions hold:

- Manifest V3 is used.
- The API origin is one exact, non-local HTTPS origin.
- The OAuth authorization and token endpoints are exact non-local HTTPS URLs without credentials,
  query strings, or fragments.
- The OAuth client ID is public, fixed at build time, and contains no client secret; scopes are
  fixed, space-delimited, include `openid`, and exclude `offline_access` so the extension cannot
  request refresh-token access.
- Permissions are exactly the reviewed `storage` and `identity` set.
- Host permissions contain exactly the configured API origin and token endpoint origin. The
  authorization endpoint and supported AI page origins are not duplicated there; ChatGPT, Claude,
  and Gemini are constrained by the reviewed content-script and web-accessible-resource matches.
- Content scripts and web-accessible UI resources match only `chatgpt.com`, `claude.ai`, and
  `gemini.google.com`; wildcard subdomains and duplicate bare/wildcard patterns are prohibited.
- The only web-accessible file is `floating-frame.html`. Refined text renders inside that
  extension-owned frame, whose one-way load handshake transfers a private `MessagePort`; the nonce
  is never announced on the host page’s window message bus.
- Broad `http://*/*` and `https://*/*` access is absent.
- Localhost access, optional host access, and the developer options page are absent.
- The 16, 32, 48, and 128-pixel Alpha icons are present and valid.
- Manifest-referenced scripts, styles, popup files, fonts, and icons exist.
- Every local HTML/CSS script, stylesheet, image, link, and font reference resolves to an archived
  file; traversal, query/fragment tricks, and missing secure-frame dependencies fail verification.
- Source maps, test files, private-key files, environment files, and the legacy developer
  gateway/options settings page are absent.
- Shipped runtime files contain neither unresolved build placeholders, local gateway URLs, nor
  legacy shared gateway-key code.
- The prominent first-use disclosure is shown before composer or recent-chat text is read, names all
  transmitted data classes, and records prompt and recent-chat consent separately.
- Chrome Web Store privacy declarations disclose prompt/recent-chat transmission and the gateway’s
  receipt of saved preferences, optional custom guidance, the supported-site identifier, and
  placeholder source field, request identifier, and occurrence-count metadata; the detected category,
  detected values, and local placeholder map remain on-device when protection is enabled and
  detection succeeds.
- Store authentication declarations cover the short-lived access token: it remains in
  `chrome.storage.session`, is sent only to Alpha’s gateway, is never refreshed by the extension, and
  is excluded from application logs.
- Store disclosures also cover source-IP and JWT-subject processing for abuse/rate/quota controls,
  disabled production raw-IP request logs, secret-keyed HMAC Redis identifiers, and fixed counter
  retention (60-second rate windows and up to 24-hour daily quota); prompts, chats, and tokens are
  excluded from logs and limiter keys.
- Consent policy version 2 is required after the secure-frame boundary and metadata disclosure;
  older saved consent is not migrated silently and users must confirm again.
- The independent verifier confirms that all five configured release values are embedded in the
  runtime and that the manifest contains the corresponding exact API and token origins.
- Extension HTML and JavaScript contain no inline, dynamically imported, or remotely hosted code.

Verify an existing archive independently with:

```sh
ALPHA_API_ORIGIN=https://api.your-domain.com \
ALPHA_OAUTH_AUTHORIZATION_ENDPOINT=https://identity.your-domain.com/oauth2/authorize \
ALPHA_OAUTH_TOKEN_ENDPOINT=https://identity.your-domain.com/oauth2/token \
ALPHA_OAUTH_CLIENT_ID=replace-with-provider-client-id \
ALPHA_OAUTH_SCOPES="openid alpha.api" \
  npm run verify:extension -- artifacts/alpha-extension-release.zip
```

## Development workflow

Load `extension/` unpacked once for UI-only development. After source changes, click the reload
control on the extension card and refresh the supported AI tab. Use an authenticated staging API
package for end-to-end tests; do not add localhost or broad host permissions back to the source
manifest. Regenerate icons from the code-owned brand source with:

```sh
node scripts/generate-extension-icons.mjs
```

The source mark is `brand/alpha-extension-icon.svg`; generated PNGs live under
`extension/assets/icons/`. The artwork uses only the approved Alpha palette.

## Release checklist

1. Run `npm ci`, followed by `npm run check`.
2. Confirm the all-up command includes the website lint, typecheck, production build, tests, and
   production dependency audit.
3. Deploy the authenticated API and record its exact HTTPS origin.
4. Register the extension as a public PKCE client and record the exact authorization endpoint,
   token endpoint, client ID, scopes, and Chrome redirect URI. Never configure or package a client
   secret.
5. Set backend CORS to the published `chrome-extension://<extension-id>` origin.
6. Increment `version` in `extension/manifest.json`; Chrome rejects reuse of an uploaded version.
7. Generate the ZIP with all five recorded build values and retain the printed SHA-256 checksum.
8. Re-run the independent verifier with those same values, then smoke-test that exact package
   through a private or trusted-tester Web Store release.
9. Confirm authentication, sign-out, token expiry, account deletion, prompt refinement, retry,
   context consent, and viewport behavior on all three supported hosts.
10. Confirm the Web Store privacy declarations match the in-product and website disclosures.
11. Upload the already-verified ZIP without modifying it.

Chrome listing screenshots and promotional tiles are publication assets rather than extension
runtime files. Produce and review them after the authenticated UI is final so the listing accurately
represents the shipped product.

## Container digest maintenance

The backend build and runtime stages use the same reviewed Node 24 Alpine digest. Keep both stages
identical, update the digest through a reviewed dependency-update change, and run the complete gate
before deployment. Production records should retain the deployed image digest for rollback and
incident response.
