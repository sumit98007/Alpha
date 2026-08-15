# Security policy

## Reporting a vulnerability

Use GitHub’s private security-advisory flow for this repository. Do not open a public issue with exploit details, user data, prompt content, access tokens, API keys, or other credentials.

Include the affected component and version, reproducible steps using synthetic data, impact, and any suggested mitigation. Do not test against other users or production infrastructure without written authorization.

## Supported release line

The current release candidate is the only supported line. Public service and Chrome Web Store support begins only after the external release gates in `UPGRADES.md` are signed off.

## Security architecture

- Provider secrets are server-only.
- Public gateway access requires short-lived, asymmetric JWT bearer tokens.
- Sensitive-pattern redaction and prompt-owned restoration occur locally in the extension.
- Context sharing is off by default and separately consented.
- Production traffic enforcement requires Redis and fails closed.
- Default request logging is disabled; Redis limiter keys use secret-keyed HMAC identifiers for source IPs and account subjects and expire with their fixed windows.
- Production packages are deterministic, least-privilege, and independently inspected before upload.

Further details are in `backend/AUTHENTICATION.md`, `PRODUCTION.md`, and `CHROME_RELEASE.md`.

## Tracked build-tool advisory

As of 9 August 2026, the Sites-compatible `vinext` build tool depends on `image-size`, for which npm reports high-severity denial-of-service advisories affecting ICNS, JXL, and HEIF parsing (`GHSA-w3rx-r6r6-pgpr` and `GHSA-5p2g-fcmc-qvqq`). No patched compatible release is published, and npm’s automated remedy is a breaking vinext downgrade.

This dependency is development/build-only and is absent from the deployed website production dependency audit. Alpha’s site build consumes reviewed repository assets only and does not accept or process untrusted ICNS, JXL, or HEIF files. CI uses locked dependencies and read-only source permissions. The dependency must be upgraded as soon as a compatible patched vinext/image-size release is available; do not suppress the full audit or use `npm audit fix --force` without a reviewed migration.
