importScripts(
  'modules/config.js',
  'modules/runtime.js',
  'modules/dlp.js',
  'modules/api-client.js',
  'modules/auth.js'
);

(function initializeAlphaBackground(globalScope) {
  'use strict';

  const {
    CONSENT_VERSION,
    DEFAULTS,
    normalizeError,
    randomUUID,
    storageGet,
    storageRemove,
    storageSet
  } = globalScope.AlphaRuntime;
  const { API_ORIGIN } = globalScope.AlphaConfig;
  const { getSession, signIn, signOut, status: authStatus } = globalScope.AlphaAuth;
  const { redact, validateAndHydrate, wireLog } = globalScope.AlphaDlp;
  const { cancel, requestJson } = globalScope.AlphaApi;
  const MAX_PROMPT_CHARACTERS = 30_000;
  const MAX_CONTEXT_CHARACTERS = 12_000;
  const MAX_GUIDANCE_CHARACTERS = 2_000;
  const MAX_OPTIMIZED_CHARACTERS = 30_000;
  const MAX_REDACTION_RECORDS = 100;
  const MAX_COUNTER_VALUE = 1_000_000_000;
  const MAX_ACTIVE_ENHANCEMENTS = 128;
  const READY_TIMEOUT_MS = 8_000;
  const MODES = new Set(['quick', 'balanced', 'deep', 'agent']);
  const TASK_TYPES = new Set([
    'auto',
    'code',
    'research',
    'career',
    'writing',
    'business',
    'study'
  ]);
  const CONTENT_HOST_PLATFORMS = new Map([
    ['chatgpt.com', 'chatgpt'],
    ['claude.ai', 'claude'],
    ['gemini.google.com', 'gemini']
  ]);
  const EXTENSION_BASE_URL = new URL(globalScope.chrome.runtime.getURL('/'));
  const activeEnhancements = new Map();

  storageRemove([
    'backendUrl',
    'accessToken',
    'accessTokenExpiresAt',
    'signedInAt',
    'refreshToken',
    'idToken',
    'oauthState',
    'pkceVerifier',
    'chatEnvironments'
  ]).catch(() => {});
  for (const area of [globalScope.chrome.storage.local, globalScope.chrome.storage.session]) {
    if (!area?.setAccessLevel) continue;
    area.setAccessLevel(
      { accessLevel: 'TRUSTED_CONTEXTS' },
      () => void globalScope.chrome.runtime.lastError
    );
  }

  function estimateTokens(text) {
    return Math.max(1, Math.ceil(String(text || '').length / 4));
  }

  function requestIdentifier(candidate) {
    if (
      typeof candidate === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidate)
    ) {
      return candidate;
    }
    return randomUUID();
  }

  function authHeaders(settings) {
    if (typeof settings.accessToken === 'string' && settings.accessToken) {
      return { Authorization: `Bearer ${settings.accessToken}` };
    }
    return {};
  }

  function emptyProtection(text = '') {
    return { scrubbedText: text, redactionLog: [], secrets: Object.create(null) };
  }

  function invalidResponse(message = 'Alpha returned an invalid response.') {
    const error = new Error(message);
    error.code = 'INVALID_RESPONSE';
    return error;
  }

  function enhancementError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  function reserveEnhancement(requestId) {
    if (activeEnhancements.has(requestId)) {
      throw enhancementError('DUPLICATE_REQUEST', 'Alpha rejected a duplicate refinement request.');
    }
    if (activeEnhancements.size >= MAX_ACTIVE_ENHANCEMENTS) {
      throw enhancementError('BUSY', 'Alpha is handling too many refinements. Try again shortly.');
    }
    const reservation = { cancelled: false, requestId };
    activeEnhancements.set(requestId, reservation);
    return reservation;
  }

  function throwIfEnhancementCancelled(reservation) {
    if (reservation.cancelled) {
      throw enhancementError('CANCELLED', 'The refinement was cancelled.');
    }
  }

  function cancelEnhancementRequest(requestId) {
    const reservation = activeEnhancements.get(requestId);
    if (reservation) reservation.cancelled = true;
    const transportCancelled = cancel(requestId);
    return Boolean(reservation || transportCancelled);
  }

  function releaseEnhancement(reservation) {
    if (activeEnhancements.get(reservation.requestId) === reservation) {
      activeEnhancements.delete(reservation.requestId);
    }
  }

  function responseObject(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw invalidResponse();
    return data;
  }

  function exactResponseKeys(data, allowed, required) {
    const keys = Object.keys(data);
    if (
      keys.some((key) => !allowed.has(key)) ||
      required.some((key) => !Object.hasOwn(data, key))
    ) {
      throw invalidResponse();
    }
  }

  function hasExactKeys(value, allowed, required = []) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const keys = Object.keys(value);
    return (
      keys.every((key) => allowed.has(key)) && required.every((key) => Object.hasOwn(value, key))
    );
  }

  function validRequestId(value) {
    return (
      typeof value === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    );
  }

  function supportedPage(value) {
    let parsed;
    try {
      parsed = new URL(value);
    } catch (_error) {
      return null;
    }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port) {
      return null;
    }
    return CONTENT_HOST_PLATFORMS.get(parsed.hostname) || null;
  }

  function contentSenderPlatform(sender) {
    if (
      sender?.id !== globalScope.chrome.runtime.id ||
      sender.frameId !== 0 ||
      !Number.isInteger(sender.tab?.id)
    ) {
      return null;
    }
    const documentPlatform = supportedPage(sender.url);
    const tabPlatform = supportedPage(sender.tab.url);
    if (!documentPlatform || documentPlatform !== tabPlatform) return null;
    if (sender.origin) {
      try {
        if (new URL(sender.origin).origin !== new URL(sender.url).origin) return null;
      } catch (_error) {
        return null;
      }
    }
    return documentPlatform;
  }

  function extensionPageSender(sender, allowedPaths) {
    if (sender?.id !== globalScope.chrome.runtime.id || typeof sender.url !== 'string') {
      return false;
    }
    try {
      const parsed = new URL(sender.url);
      return (
        parsed.protocol === 'chrome-extension:' &&
        parsed.protocol === EXTENSION_BASE_URL.protocol &&
        parsed.host === EXTENSION_BASE_URL.host &&
        !parsed.search &&
        !parsed.hash &&
        allowedPaths.has(parsed.pathname)
      );
    } catch (_error) {
      return false;
    }
  }

  function validPreferences(preferences) {
    if (preferences === undefined) return true;
    if (!hasExactKeys(preferences, new Set(['mode', 'taskType', 'bypassCache']))) {
      return false;
    }
    return (
      (preferences.mode === undefined || MODES.has(preferences.mode)) &&
      (preferences.taskType === undefined || TASK_TYPES.has(preferences.taskType)) &&
      (preferences.bypassCache === undefined || typeof preferences.bypassCache === 'boolean')
    );
  }

  function validateMessage(message, sender) {
    if (
      !hasExactKeys(
        message,
        new Set([
          'action',
          'requestId',
          'text',
          'platform',
          'conversationContext',
          'preferences',
          'prompt',
          'context',
          'acceptedAt',
          'position'
        ]),
        ['action']
      ) ||
      typeof message.action !== 'string'
    ) {
      return { ok: false, code: 'INVALID_MESSAGE' };
    }

    const popupSender = extensionPageSender(sender, new Set(['/popup.html']));
    if (['getAuthStatus', 'startSignIn', 'signOut', 'checkService'].includes(message.action)) {
      return Object.keys(message).length === 1 && popupSender
        ? { ok: true }
        : { ok: false, code: popupSender ? 'INVALID_MESSAGE' : 'FORBIDDEN' };
    }
    if (message.action === 'openPrivacyNotice') {
      return Object.keys(message).length === 1 && popupSender
        ? { ok: true }
        : { ok: false, code: popupSender ? 'INVALID_MESSAGE' : 'FORBIDDEN' };
    }

    const senderPlatform = contentSenderPlatform(sender);
    if (!senderPlatform) return { ok: false, code: 'FORBIDDEN' };

    if (message.action === 'getFloatingUiState') {
      return Object.keys(message).length === 1
        ? { ok: true, senderPlatform }
        : { ok: false, code: 'INVALID_MESSAGE' };
    }
    if (message.action === 'saveFloatingConsent') {
      const acceptedAt =
        typeof message.acceptedAt === 'string' ? new Date(message.acceptedAt) : null;
      return hasExactKeys(message, new Set(['action', 'prompt', 'context', 'acceptedAt']), [
        'action',
        'prompt',
        'context',
        'acceptedAt'
      ]) &&
        typeof message.prompt === 'boolean' &&
        typeof message.context === 'boolean' &&
        (message.prompt || message.context) &&
        acceptedAt &&
        Number.isFinite(acceptedAt.getTime()) &&
        acceptedAt.toISOString() === message.acceptedAt &&
        Math.abs(Date.now() - acceptedAt.getTime()) <= 5 * 60_000
        ? { ok: true, senderPlatform }
        : { ok: false, code: 'INVALID_MESSAGE' };
    }
    if (message.action === 'saveFloatingPosition') {
      const position = message.position;
      const validPosition =
        position === null ||
        (hasExactKeys(position, new Set(['x', 'y']), ['x', 'y']) &&
          Number.isFinite(position.x) &&
          position.x >= 0 &&
          position.x <= 1 &&
          Number.isFinite(position.y) &&
          position.y >= 0 &&
          position.y <= 1);
      return hasExactKeys(message, new Set(['action', 'position']), ['action', 'position']) &&
        validPosition
        ? { ok: true, senderPlatform }
        : { ok: false, code: 'INVALID_MESSAGE' };
    }

    if (message.action === 'cancelEnhancement') {
      return hasExactKeys(message, new Set(['action', 'requestId']), ['action', 'requestId']) &&
        validRequestId(message.requestId)
        ? { ok: true, senderPlatform }
        : { ok: false, code: 'INVALID_MESSAGE' };
    }
    if (message.action === 'enhancePrompt') {
      return hasExactKeys(
        message,
        new Set(['action', 'requestId', 'text', 'platform', 'conversationContext', 'preferences']),
        ['action', 'requestId', 'text', 'platform']
      ) &&
        validRequestId(message.requestId) &&
        message.platform === senderPlatform &&
        typeof message.text === 'string' &&
        message.text.length <= MAX_PROMPT_CHARACTERS &&
        (message.conversationContext === undefined ||
          (typeof message.conversationContext === 'string' &&
            message.conversationContext.length <= MAX_CONTEXT_CHARACTERS)) &&
        validPreferences(message.preferences)
        ? { ok: true, senderPlatform }
        : { ok: false, code: 'INVALID_MESSAGE' };
    }
    return { ok: false, code: 'INVALID_MESSAGE' };
  }

  function boundedString(value, maximum, fieldName) {
    if (typeof value !== 'string' || !value.trim() || value.length > maximum) {
      throw invalidResponse(`Alpha returned an invalid ${fieldName}.`);
    }
    return value;
  }

  function safeCounter(value) {
    return Number.isSafeInteger(value) && value >= 0 ? Math.min(value, MAX_COUNTER_VALUE) : 0;
  }

  function safeFloatingPosition(value) {
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).some((key) => key !== 'x' && key !== 'y') ||
      !Number.isFinite(value.x) ||
      !Number.isFinite(value.y)
    ) {
      return null;
    }
    return {
      x: Math.min(1, Math.max(0, value.x)),
      y: Math.min(1, Math.max(0, value.y))
    };
  }

  function normalizeStoredSettings(value) {
    const settings = value && typeof value === 'object' ? value : {};
    const booleanSetting = (key) =>
      typeof settings[key] === 'boolean' ? settings[key] : DEFAULTS[key];
    return {
      enabled: booleanSetting('enabled'),
      enhancementMode: MODES.has(settings.enhancementMode)
        ? settings.enhancementMode
        : DEFAULTS.enhancementMode,
      taskField: TASK_TYPES.has(settings.taskField) ? settings.taskField : DEFAULTS.taskField,
      protectSensitive: booleanSetting('protectSensitive'),
      preserveVoice: booleanSetting('preserveVoice'),
      askClarifying: booleanSetting('askClarifying'),
      qualityChecks: booleanSetting('qualityChecks'),
      useChatContext: booleanSetting('useChatContext'),
      customGuidance:
        typeof settings.customGuidance === 'string'
          ? settings.customGuidance.trim().slice(0, MAX_GUIDANCE_CHARACTERS)
          : '',
      redactedCount: safeCounter(settings.redactedCount),
      optimizedCount: safeCounter(settings.optimizedCount),
      privacyConsentVersion:
        settings.privacyConsentVersion === CONSENT_VERSION ? CONSENT_VERSION : 0,
      contextConsentVersion:
        settings.contextConsentVersion === CONSENT_VERSION ? CONSENT_VERSION : 0,
      privacyConsentAt:
        typeof settings.privacyConsentAt === 'string'
          ? settings.privacyConsentAt.slice(0, 40)
          : null,
      contextConsentAt:
        typeof settings.contextConsentAt === 'string'
          ? settings.contextConsentAt.slice(0, 40)
          : null,
      floatingPosition: safeFloatingPosition(settings.floatingPosition)
    };
  }

  function incrementCounter(value, increment = 1) {
    return Math.min(MAX_COUNTER_VALUE, safeCounter(value) + Math.max(0, increment));
  }

  function tokenEstimate(value, fallback) {
    return Number.isInteger(value) && value > 0 && value <= 100_000 ? value : fallback;
  }

  async function loadSettings({ requiredAuth = true } = {}) {
    const [rawSettings, authSession] = await Promise.all([
      storageGet(DEFAULTS),
      getSession({ required: requiredAuth })
    ]);
    return { ...normalizeStoredSettings(rawSettings), ...authSession };
  }

  async function settingsFingerprint(settings) {
    const input = JSON.stringify({
      enhancementMode: settings.enhancementMode,
      taskField: settings.taskField,
      protectSensitive: settings.protectSensitive,
      preserveVoice: settings.preserveVoice,
      askClarifying: settings.askClarifying,
      qualityChecks: settings.qualityChecks,
      useChatContext: settings.useChatContext,
      customGuidance: settings.customGuidance
    });
    const digest = await globalScope.crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(input)
    );
    return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join(
      ''
    );
  }

  async function getFloatingUiState() {
    const settings = normalizeStoredSettings(await storageGet(DEFAULTS));
    return {
      success: true,
      state: {
        enabled: settings.enabled,
        useChatContext: settings.useChatContext,
        privacyConsentVersion: settings.privacyConsentVersion,
        contextConsentVersion: settings.contextConsentVersion,
        consentVersion: CONSENT_VERSION,
        fingerprint: await settingsFingerprint(settings),
        floatingPosition: settings.floatingPosition
      }
    };
  }

  async function saveFloatingConsent(message) {
    const settings = normalizeStoredSettings(await storageGet(DEFAULTS));
    if (message.context && !settings.useChatContext) {
      const error = new Error('Recent-chat consent is unavailable while chat context is disabled.');
      error.code = 'VALIDATION';
      throw error;
    }
    const acceptedAt = new Date().toISOString();
    const values = {};
    if (message.prompt) {
      values.privacyConsentVersion = CONSENT_VERSION;
      values.privacyConsentAt = acceptedAt;
    }
    if (message.context) {
      values.contextConsentVersion = CONSENT_VERSION;
      values.contextConsentAt = acceptedAt;
    }
    await storageSet(values);
    return { success: true };
  }

  async function saveFloatingPosition(message) {
    if (message.position === null) await storageRemove('floatingPosition');
    else await storageSet({ floatingPosition: message.position });
    return { success: true };
  }

  function validateEnhancementResponse(data, requestId) {
    const response = responseObject(data);
    exactResponseKeys(
      response,
      new Set([
        'sessionId',
        'optimizedText',
        'cached',
        'mode',
        'taskType',
        'estimatedTokens',
        'degraded',
        'contextUsed'
      ]),
      ['sessionId', 'optimizedText', 'cached', 'mode', 'taskType', 'estimatedTokens', 'contextUsed']
    );
    if (
      response.sessionId !== requestId ||
      typeof response.cached !== 'boolean' ||
      !MODES.has(response.mode) ||
      !TASK_TYPES.has(response.taskType) ||
      !Number.isInteger(response.estimatedTokens) ||
      response.estimatedTokens < 1 ||
      response.estimatedTokens > MAX_OPTIMIZED_CHARACTERS ||
      typeof response.contextUsed !== 'boolean' ||
      (response.degraded !== undefined && typeof response.degraded !== 'boolean')
    ) {
      throw invalidResponse();
    }
    boundedString(response.optimizedText, MAX_OPTIMIZED_CHARACTERS, 'refined prompt');
    return response;
  }

  function requirePromptConsent(settings) {
    if (settings.privacyConsentVersion !== CONSENT_VERSION) {
      const error = new Error('Review and accept Alpha’s privacy notice before refining a prompt.');
      error.code = 'CONSENT_REQUIRED';
      throw error;
    }
  }

  async function enhancePrompt(message) {
    const text = typeof message.text === 'string' ? message.text : '';
    const platform = typeof message.platform === 'string' ? message.platform : 'generic';
    const preferences =
      message.preferences && typeof message.preferences === 'object' ? message.preferences : {};
    if (!text.trim()) return { success: false, code: 'VALIDATION', error: 'Write a prompt first.' };
    if (text.length > MAX_PROMPT_CHARACTERS) {
      return {
        success: false,
        code: 'TOO_LARGE',
        error: 'This prompt is too large to refine safely.'
      };
    }

    const requestId = requestIdentifier(message.requestId);
    const reservation = reserveEnhancement(requestId);
    try {
      const settings = await loadSettings();
      throwIfEnhancementCancelled(reservation);
      if (!settings.enabled) {
        return {
          success: false,
          code: 'DISABLED',
          error: 'Alpha is disabled. Turn it on from the extension menu.'
        };
      }
      requirePromptConsent(settings);

      const rawContext =
        settings.useChatContext && typeof message.conversationContext === 'string'
          ? message.conversationContext.slice(-MAX_CONTEXT_CHARACTERS)
          : '';
      if (rawContext && settings.contextConsentVersion !== CONSENT_VERSION) {
        throw enhancementError(
          'CONTEXT_CONSENT_REQUIRED',
          'Allow recent-chat processing before using current chat context.'
        );
      }

      const promptProtection = settings.protectSensitive
        ? redact(text, { requestId, source: 'PROMPT' })
        : emptyProtection(text);
      const contextProtection =
        settings.protectSensitive && rawContext
          ? redact(rawContext, { requestId, source: 'CONTEXT' })
          : emptyProtection(rawContext);
      const customGuidance =
        typeof settings.customGuidance === 'string'
          ? settings.customGuidance.trim().slice(0, MAX_GUIDANCE_CHARACTERS)
          : '';
      const guidanceProtection =
        settings.protectSensitive && customGuidance
          ? redact(customGuidance, { requestId, source: 'GUIDANCE' })
          : emptyProtection(customGuidance);
      const protectedGuidance = guidanceProtection.scrubbedText;
      const allRedactions = [
        ...promptProtection.redactionLog,
        ...contextProtection.redactionLog,
        ...guidanceProtection.redactionLog
      ];
      if (allRedactions.length > MAX_REDACTION_RECORDS) {
        return {
          success: false,
          code: 'REDACTION_LIMIT',
          error:
            'This request contains too many recognised sensitive values to refine safely. Remove some and try again; nothing was sent.'
        };
      }

      throwIfEnhancementCancelled(reservation);
      const data = await requestJson({
        baseUrl: API_ORIGIN,
        path: '/api/enhance',
        method: 'POST',
        headers: authHeaders(settings),
        requestId,
        body: {
          sessionId: requestId,
          meta: { hostPlatform: platform },
          payload: {
            scrubbedText: promptProtection.scrubbedText,
            redactionLog: wireLog(allRedactions)
          },
          preferences: {
            mode: preferences.mode || settings.enhancementMode || 'balanced',
            taskType: preferences.taskType || settings.taskField || 'auto',
            customGuidance: protectedGuidance,
            preserveVoice: Boolean(settings.preserveVoice),
            askClarifying: Boolean(settings.askClarifying),
            qualityChecks: Boolean(settings.qualityChecks),
            conversationContext: contextProtection.scrubbedText,
            bypassCache: preferences.bypassCache === true
          }
        }
      });

      throwIfEnhancementCancelled(reservation);
      const enhancementData = validateEnhancementResponse(data, requestId);
      const optimizedText = boundedString(
        enhancementData.optimizedText,
        MAX_OPTIMIZED_CHARACTERS,
        'refined prompt'
      );
      const integrity = validateAndHydrate(optimizedText, promptProtection);
      const degraded = enhancementData.degraded === true || !integrity.ok;
      const finalText = degraded ? text : integrity.text;
      const secretsCount = allRedactions.length;
      await storageSet({
        redactedCount: incrementCounter(settings.redactedCount, secretsCount),
        optimizedCount: incrementCounter(settings.optimizedCount)
      });
      throwIfEnhancementCancelled(reservation);

      return {
        success: true,
        text: finalText,
        cached: enhancementData.cached === true,
        redactedThisSession: secretsCount,
        restoredSensitiveCount: promptProtection.redactionLog.length,
        mode: enhancementData.mode,
        taskType: enhancementData.taskType,
        estimatedTokens: degraded
          ? estimateTokens(text)
          : tokenEstimate(enhancementData.estimatedTokens, estimateTokens(finalText)),
        originalEstimatedTokens: estimateTokens(text),
        degraded,
        integrityReason: integrity.ok ? undefined : integrity.reason,
        contextUsed: Boolean(contextProtection.scrubbedText)
      };
    } finally {
      releaseEnhancement(reservation);
    }
  }

  function errorResponse(error) {
    return {
      success: false,
      code: error?.code || 'UNAVAILABLE',
      error: normalizeError(error)
    };
  }

  async function checkService() {
    const settings = await loadSettings();
    const data = await requestJson({
      baseUrl: API_ORIGIN,
      path: '/api/ready',
      headers: authHeaders(settings),
      timeoutMs: READY_TIMEOUT_MS
    });
    const readyData = responseObject(data);
    exactResponseKeys(readyData, new Set(['status']), ['status']);
    return { success: readyData.status === 'ready' };
  }

  globalScope.chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const validation = validateMessage(message, sender);
    if (!validation.ok) {
      sendResponse({
        success: false,
        code: validation.code,
        error:
          validation.code === 'FORBIDDEN'
            ? 'This Alpha action is not allowed from the current page.'
            : 'Alpha rejected an invalid request.'
      });
      return false;
    }

    if (message.action === 'openPrivacyNotice') {
      globalScope.chrome.tabs.create(
        { url: globalScope.chrome.runtime.getURL('privacy.html') },
        () => {
          const error = globalScope.chrome.runtime.lastError;
          sendResponse(
            error
              ? { success: false, error: 'Alpha could not open the privacy notice.' }
              : { success: true }
          );
        }
      );
      return true;
    }

    if (message.action === 'cancelEnhancement') {
      sendResponse({ success: true, cancelled: cancelEnhancementRequest(message.requestId) });
      return false;
    }

    if (message.action === 'getAuthStatus') {
      authStatus()
        .then(sendResponse)
        .catch((error) => sendResponse(errorResponse(error)));
      return true;
    }

    if (message.action === 'startSignIn') {
      signIn()
        .then(sendResponse)
        .catch((error) => sendResponse(errorResponse(error)));
      return true;
    }

    if (message.action === 'signOut') {
      signOut()
        .then(sendResponse)
        .catch((error) => sendResponse(errorResponse(error)));
      return true;
    }

    let operation;
    if (message.action === 'getFloatingUiState') operation = getFloatingUiState();
    else if (message.action === 'saveFloatingConsent') operation = saveFloatingConsent(message);
    else if (message.action === 'saveFloatingPosition') operation = saveFloatingPosition(message);
    else if (message.action === 'enhancePrompt') operation = enhancePrompt(message);
    else if (message.action === 'checkService') operation = checkService();
    else return false;

    operation.then(sendResponse).catch(async (error) => {
      if (error?.code === 'AUTH') {
        await signOut().catch(() => {});
        sendResponse({
          success: false,
          code: 'AUTH_EXPIRED',
          error: 'Your Alpha session expired. Sign in again from the extension menu.'
        });
        return;
      }
      sendResponse(errorResponse(error));
    });
    return true;
  });
})(globalThis);
