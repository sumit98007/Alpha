(function initializeAlphaConfig(globalScope) {
  'use strict';

  globalScope.AlphaConfig = Object.freeze({
    API_ORIGIN: 'https://api.alpha.invalid',
    OAUTH_AUTHORIZATION_ENDPOINT: 'https://auth.alpha.invalid/oauth2/authorize',
    OAUTH_TOKEN_ENDPOINT: 'https://auth.alpha.invalid/oauth2/token',
    OAUTH_CLIENT_ID: 'alpha-extension-client.invalid',
    OAUTH_SCOPES: 'openid alpha.api.invalid',
    OAUTH_REDIRECT_PATH: 'alpha-oauth'
  });
})(globalThis);
