# Alpha website

Product, trust, support, and hosted-account preview surfaces for Alpha. The source is not approved for public release until the external publication gates in `../UPGRADES.md` are complete. The site runs on the OpenAI Sites vinext runtime and uses the platform-owned Sign in with ChatGPT flow for preview identity.

## Local development

Node.js 24 or newer is required. Set `NEXT_PUBLIC_SITE_URL` to the final canonical HTTPS origin when building for a custom domain; the private Sites review origin is the fallback used by metadata previews.

```bash
npm install
npm run dev
npm run lint
npm run typecheck
npm test
npm run verify
```

Product routes are `/`, `/privacy`, `/security`, `/terms`, and `/support`. `/account` renders an anonymous preview state locally and receives verified identity headers after Sites deployment; it does not sign the extension in.

## Authentication boundary

`app/chatgpt-auth.ts` is the only account-auth integration. The hosting platform owns `/signin-with-chatgpt`, `/signout-with-chatgpt`, `/callback`, OAuth cookies, and identity header injection. Do not add application routes with those reserved paths or handle passwords in this codebase.

Sign in with ChatGPT establishes website identity. Extension-to-gateway authorization remains a separate production integration and must use short-lived, per-user tokens.

## Brand

The site uses the palette and typography documented in `../DESIGN_LANGUAGE.md`. Boldonse is served locally from `public/fonts` under its bundled SIL Open Font License.
