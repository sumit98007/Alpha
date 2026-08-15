(function initializeAlphaFrameProtocol(globalScope) {
  'use strict';

  const PROTOCOL = 'alpha-floating-frame-v1';
  const MAX_PROMPT_CHARACTERS = 30_000;
  const MAX_CONTEXT_CHARACTERS = 12_000;
  const MAX_ERROR_CHARACTERS = 240;
  const SUPPORTED_HOSTS = new Set(['chatgpt.com', 'claude.ai', 'gemini.google.com']);
  const SHELL_STATES = new Set(['collapsed', 'thinking', 'expanded', 'notice']);
  const PLATFORM_IDS = new Set(['chatgpt', 'claude', 'gemini', 'generic']);
  const ENHANCEMENT_MODES = new Set(['quick', 'balanced', 'deep', 'agent']);
  const TASK_TYPES = new Set([
    'auto',
    'code',
    'research',
    'career',
    'writing',
    'business',
    'study'
  ]);

  function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function hasExactKeys(value, expectedKeys) {
    if (!isRecord(value)) return false;
    const actualKeys = Object.keys(value).sort();
    const sortedExpected = [...expectedKeys].sort();
    return (
      actualKeys.length === sortedExpected.length &&
      actualKeys.every((key, index) => key === sortedExpected[index])
    );
  }

  function isNonce(value) {
    return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
  }

  function isRequestId(value) {
    return (
      typeof value === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
    );
  }

  function isBoundedString(value, maximum, { allowEmpty = true } = {}) {
    return (
      typeof value === 'string' &&
      value.length <= maximum &&
      (allowEmpty || value.trim().length > 0)
    );
  }

  function isUnitInterval(value) {
    return Number.isFinite(value) && value >= 0 && value <= 1;
  }

  function isDimension(value) {
    return Number.isInteger(value) && value >= 1 && value <= 2_000;
  }

  function isViewportDimension(value) {
    return Number.isInteger(value) && value >= 1 && value <= 16_384;
  }

  function isMovement(value) {
    return Number.isFinite(value) && Math.abs(value) <= 2_000;
  }

  function isActivation(value) {
    return (
      hasExactKeys(value, ['clientX', 'clientY', 'occurredAt']) &&
      Number.isFinite(value.clientX) &&
      value.clientX >= 0 &&
      value.clientX <= 16_384 &&
      Number.isFinite(value.clientY) &&
      value.clientY >= 0 &&
      value.clientY <= 16_384 &&
      Number.isSafeInteger(value.occurredAt) &&
      value.occurredAt > 0
    );
  }

  function baseEnvelope(message, nonce, type) {
    return (
      isRecord(message) &&
      message.protocol === PROTOCOL &&
      message.type === type &&
      message.nonce === nonce &&
      isNonce(message.nonce)
    );
  }

  function validateChannelInit(message, nonce) {
    return (
      baseEnvelope(message, nonce, 'channel-init') &&
      hasExactKeys(message, ['protocol', 'type', 'nonce'])
    );
  }

  function validUserRequest(message) {
    if (
      !hasExactKeys(message, [
        'protocol',
        'type',
        'nonce',
        'requestId',
        'command',
        'payload',
        'activation'
      ]) ||
      !isRequestId(message.requestId) ||
      !isRecord(message.payload)
    ) {
      return false;
    }

    const requiresActivation = new Set([
      'collect-input',
      'collect-context',
      'set-composer',
      'enhance-prompt',
      'save-consent'
    ]).has(message.command);
    if (
      (requiresActivation && !isActivation(message.activation)) ||
      (!requiresActivation && message.activation !== null)
    ) {
      return false;
    }

    if (message.command === 'collect-input') {
      return (
        hasExactKeys(message.payload, ['includeContext']) &&
        typeof message.payload.includeContext === 'boolean'
      );
    }
    if (message.command === 'collect-context') {
      return hasExactKeys(message.payload, []);
    }
    if (message.command === 'set-composer') {
      return (
        hasExactKeys(message.payload, ['text']) &&
        isBoundedString(message.payload.text, MAX_PROMPT_CHARACTERS, { allowEmpty: false })
      );
    }
    if (message.command === 'enhance-prompt') {
      return (
        hasExactKeys(message.payload, ['text', 'platform', 'conversationContext', 'bypassCache']) &&
        isBoundedString(message.payload.text, MAX_PROMPT_CHARACTERS, { allowEmpty: false }) &&
        PLATFORM_IDS.has(message.payload.platform) &&
        isBoundedString(message.payload.conversationContext, MAX_CONTEXT_CHARACTERS) &&
        typeof message.payload.bypassCache === 'boolean'
      );
    }
    if (message.command === 'cancel-enhancement') {
      return (
        hasExactKeys(message.payload, ['targetRequestId']) &&
        isRequestId(message.payload.targetRequestId)
      );
    }
    if (message.command === 'get-settings') {
      return hasExactKeys(message.payload, []);
    }
    if (message.command === 'save-consent') {
      return (
        hasExactKeys(message.payload, ['prompt', 'context', 'acceptedAt']) &&
        typeof message.payload.prompt === 'boolean' &&
        typeof message.payload.context === 'boolean' &&
        (message.payload.prompt || message.payload.context) &&
        typeof message.payload.acceptedAt === 'string' &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(message.payload.acceptedAt)
      );
    }
    return false;
  }

  function validShellControl(message) {
    if (
      !hasExactKeys(message, ['protocol', 'type', 'nonce', 'command', 'payload']) ||
      !isRecord(message.payload)
    ) {
      return false;
    }

    if (message.command === 'layout') {
      return (
        hasExactKeys(message.payload, ['state', 'width', 'height']) &&
        SHELL_STATES.has(message.payload.state) &&
        isDimension(message.payload.width) &&
        isDimension(message.payload.height)
      );
    }
    if (message.command === 'move') {
      return (
        hasExactKeys(message.payload, ['phase', 'deltaX', 'deltaY', 'trustedAction']) &&
        new Set(['start', 'move', 'end']).has(message.payload.phase) &&
        isMovement(message.payload.deltaX) &&
        isMovement(message.payload.deltaY) &&
        message.payload.trustedAction === true
      );
    }
    if (message.command === 'restore-position') {
      return (
        hasExactKeys(message.payload, ['x', 'y']) &&
        isUnitInterval(message.payload.x) &&
        isUnitInterval(message.payload.y)
      );
    }
    if (message.command === 'reset-position') {
      return (
        hasExactKeys(message.payload, ['trustedAction']) && message.payload.trustedAction === true
      );
    }
    return false;
  }

  function validateFrameToBridge(message, nonce) {
    if (!baseEnvelope(message, nonce, message?.type)) return false;
    if (message.type === 'channel-ack') {
      return hasExactKeys(message, ['protocol', 'type', 'nonce']);
    }
    if (message.type === 'bridge-request') return validUserRequest(message);
    if (message.type === 'shell-control') return validShellControl(message);
    return false;
  }

  function validSuccessfulResult(command, result) {
    if (!isRecord(result)) return false;
    if (command === 'collect-input') {
      return (
        hasExactKeys(result, ['rawText', 'context', 'platform', 'displayName']) &&
        isBoundedString(result.rawText, MAX_PROMPT_CHARACTERS) &&
        isBoundedString(result.context, MAX_CONTEXT_CHARACTERS) &&
        PLATFORM_IDS.has(result.platform) &&
        isBoundedString(result.displayName, 80, { allowEmpty: false })
      );
    }
    if (command === 'collect-context') {
      return (
        hasExactKeys(result, ['context']) && isBoundedString(result.context, MAX_CONTEXT_CHARACTERS)
      );
    }
    if (command === 'set-composer') return hasExactKeys(result, []);
    if (command === 'enhance-prompt') {
      return hasExactKeys(result, ['response']) && validEnhancementResponse(result.response);
    }
    if (command === 'cancel-enhancement') {
      return hasExactKeys(result, ['cancelled']) && typeof result.cancelled === 'boolean';
    }
    if (command === 'get-settings') {
      return (
        hasExactKeys(result, [
          'enabled',
          'useChatContext',
          'privacyConsentVersion',
          'contextConsentVersion',
          'consentVersion',
          'fingerprint',
          'floatingPosition'
        ]) &&
        typeof result.enabled === 'boolean' &&
        typeof result.useChatContext === 'boolean' &&
        Number.isInteger(result.privacyConsentVersion) &&
        result.privacyConsentVersion >= 0 &&
        Number.isInteger(result.contextConsentVersion) &&
        result.contextConsentVersion >= 0 &&
        Number.isInteger(result.consentVersion) &&
        result.consentVersion >= 1 &&
        /^[0-9a-f]{64}$/u.test(result.fingerprint) &&
        (result.floatingPosition === null ||
          (hasExactKeys(result.floatingPosition, ['x', 'y']) &&
            isUnitInterval(result.floatingPosition.x) &&
            isUnitInterval(result.floatingPosition.y)))
      );
    }
    if (command === 'save-consent') return hasExactKeys(result, []);
    return false;
  }

  function validEnhancementResponse(response) {
    if (!isRecord(response) || typeof response.success !== 'boolean') return false;
    if (!response.success) {
      return (
        hasExactKeys(response, ['success', 'code', 'error']) &&
        isBoundedString(response.code, 64, { allowEmpty: false }) &&
        isBoundedString(response.error, MAX_ERROR_CHARACTERS, { allowEmpty: false })
      );
    }

    const allowedKeys = new Set([
      'success',
      'text',
      'cached',
      'redactedThisSession',
      'restoredSensitiveCount',
      'mode',
      'taskType',
      'estimatedTokens',
      'originalEstimatedTokens',
      'degraded',
      'integrityReason',
      'contextUsed'
    ]);
    const requiredKeys = [
      'success',
      'text',
      'cached',
      'redactedThisSession',
      'restoredSensitiveCount',
      'mode',
      'taskType',
      'estimatedTokens',
      'originalEstimatedTokens',
      'degraded',
      'contextUsed'
    ];
    if (
      Object.keys(response).some((key) => !allowedKeys.has(key)) ||
      requiredKeys.some((key) => !Object.hasOwn(response, key))
    ) {
      return false;
    }
    return (
      isBoundedString(response.text, MAX_PROMPT_CHARACTERS, { allowEmpty: false }) &&
      typeof response.cached === 'boolean' &&
      Number.isInteger(response.redactedThisSession) &&
      response.redactedThisSession >= 0 &&
      Number.isInteger(response.restoredSensitiveCount) &&
      response.restoredSensitiveCount >= 0 &&
      ENHANCEMENT_MODES.has(response.mode) &&
      TASK_TYPES.has(response.taskType) &&
      Number.isInteger(response.estimatedTokens) &&
      response.estimatedTokens >= 1 &&
      response.estimatedTokens <= MAX_PROMPT_CHARACTERS &&
      Number.isInteger(response.originalEstimatedTokens) &&
      response.originalEstimatedTokens >= 1 &&
      response.originalEstimatedTokens <= MAX_PROMPT_CHARACTERS &&
      typeof response.degraded === 'boolean' &&
      typeof response.contextUsed === 'boolean' &&
      (response.integrityReason === undefined ||
        isBoundedString(response.integrityReason, 80, { allowEmpty: false }))
    );
  }

  function validateBridgeResponse(message, nonce, expectedCommand) {
    if (!baseEnvelope(message, nonce, 'bridge-response')) return false;
    if (
      message.command !== expectedCommand ||
      !isRequestId(message.requestId) ||
      typeof message.ok !== 'boolean'
    ) {
      return false;
    }
    if (message.ok) {
      return (
        hasExactKeys(message, [
          'protocol',
          'type',
          'nonce',
          'requestId',
          'command',
          'ok',
          'result'
        ]) && validSuccessfulResult(message.command, message.result)
      );
    }
    return (
      hasExactKeys(message, ['protocol', 'type', 'nonce', 'requestId', 'command', 'ok', 'error']) &&
      isBoundedString(message.error, MAX_ERROR_CHARACTERS, { allowEmpty: false })
    );
  }

  function validateBridgeEvent(message, nonce) {
    if (
      !baseEnvelope(message, nonce, 'bridge-event') ||
      !hasExactKeys(message, ['protocol', 'type', 'nonce', 'event', 'payload']) ||
      !isRecord(message.payload)
    ) {
      return false;
    }
    if (message.event === 'channel-ready') {
      return (
        hasExactKeys(message.payload, ['platform', 'displayName', 'width', 'height']) &&
        PLATFORM_IDS.has(message.payload.platform) &&
        isBoundedString(message.payload.displayName, 80, { allowEmpty: false }) &&
        isViewportDimension(message.payload.width) &&
        isViewportDimension(message.payload.height)
      );
    }
    if (message.event === 'viewport') {
      return (
        hasExactKeys(message.payload, ['width', 'height']) &&
        isViewportDimension(message.payload.width) &&
        isViewportDimension(message.payload.height)
      );
    }
    if (message.event === 'position') {
      return (
        hasExactKeys(message.payload, ['x', 'y']) &&
        isUnitInterval(message.payload.x) &&
        isUnitInterval(message.payload.y)
      );
    }
    return false;
  }

  function validateBridgeToFrame(message, nonce, expectedCommand) {
    if (message?.type === 'bridge-response') {
      return validateBridgeResponse(message, nonce, expectedCommand);
    }
    return validateBridgeEvent(message, nonce);
  }

  function isTrustedUserEvent(event) {
    return Boolean(event && event.isTrusted === true);
  }

  function trustedHandler(handler) {
    return function handleTrustedEvent(event, ...argumentsList) {
      if (!isTrustedUserEvent(event)) return undefined;
      return handler.call(this, event, ...argumentsList);
    };
  }

  function isAuthenticatedParentWindowEvent(event, parentWindow, parentOrigin, nonce) {
    return Boolean(
      isTrustedUserEvent(event) &&
        event.source === parentWindow &&
        event.origin === parentOrigin &&
        validateChannelInit(event.data, nonce)
    );
  }

  function isAuthenticatedPortEvent(event, port, nonce, validator, ...validatorArguments) {
    const correctTarget = event?.target === port || event?.currentTarget === port;
    return Boolean(
      isTrustedUserEvent(event) &&
        correctTarget &&
        validator(event.data, nonce, ...validatorArguments)
    );
  }

  function createNonce(cryptoProvider = globalScope.crypto) {
    if (typeof cryptoProvider?.getRandomValues !== 'function') {
      throw new Error('Secure random number generation is unavailable.');
    }
    const bytes = new Uint8Array(32);
    cryptoProvider.getRandomValues(bytes);
    return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
  }

  function createRequestId(cryptoProvider = globalScope.crypto) {
    if (typeof cryptoProvider?.randomUUID === 'function') {
      const requestId = cryptoProvider.randomUUID();
      if (isRequestId(requestId)) return requestId;
    }
    if (typeof cryptoProvider?.getRandomValues !== 'function') {
      throw new Error('Secure random number generation is unavailable.');
    }
    const bytes = new Uint8Array(16);
    cryptoProvider.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  function captureTrustedActivation(event, now = Date.now()) {
    if (!isTrustedUserEvent(event) || !Number.isSafeInteger(now) || now <= 0) {
      throw new Error('A recent trusted user action is required.');
    }
    let clientX = event.clientX;
    let clientY = event.clientY;
    if (
      (!Number.isFinite(clientX) ||
        !Number.isFinite(clientY) ||
        (clientX === 0 && clientY === 0 && event.detail === 0)) &&
      typeof event.currentTarget?.getBoundingClientRect === 'function'
    ) {
      const rect = event.currentTarget.getBoundingClientRect();
      clientX = rect.left + rect.width / 2;
      clientY = rect.top + rect.height / 2;
    }
    const activation = { clientX, clientY, occurredAt: now };
    if (!isActivation(activation)) {
      throw new Error('Alpha could not verify that user action.');
    }
    return Object.freeze(activation);
  }

  async function createCacheFingerprint(
    rawText,
    context,
    settingsFingerprint,
    cryptoProvider = globalScope.crypto
  ) {
    if (
      !isBoundedString(rawText, MAX_PROMPT_CHARACTERS, { allowEmpty: false }) ||
      !isBoundedString(context, MAX_CONTEXT_CHARACTERS) ||
      typeof settingsFingerprint !== 'string' ||
      !/^[0-9a-f]{64}$/u.test(settingsFingerprint) ||
      typeof cryptoProvider?.subtle?.digest !== 'function'
    ) {
      throw new Error('Alpha could not create a private refinement cache key.');
    }
    const canonical = JSON.stringify([settingsFingerprint, rawText, context]);
    const bytes = new TextEncoder().encode(canonical);
    const digest = new Uint8Array(await cryptoProvider.subtle.digest('SHA-256', bytes));
    return Array.from(digest, (value) => value.toString(16).padStart(2, '0')).join('');
  }

  function createRefinementCoordinator() {
    let locked = false;
    const inFlightRequestIds = new Set();
    return Object.freeze({
      acquire() {
        if (locked) return false;
        locked = true;
        return true;
      },
      release() {
        locked = false;
      },
      isLocked() {
        return locked;
      },
      track(requestId) {
        if (!isRequestId(requestId)) throw new Error('Invalid enhancement request identifier.');
        inFlightRequestIds.add(requestId);
      },
      untrack(requestId) {
        inFlightRequestIds.delete(requestId);
      },
      requestIds() {
        return [...inFlightRequestIds];
      },
      async cancelAll(cancelRequest) {
        if (typeof cancelRequest !== 'function') {
          throw new Error('A cancellation function is required.');
        }
        const requestIds = [...inFlightRequestIds];
        await Promise.allSettled(requestIds.map((requestId) => cancelRequest(requestId)));
        return requestIds;
      }
    });
  }

  function extensionOrigin(runtime = globalScope.chrome?.runtime) {
    const frameUrl = new URL(runtime.getURL('floating-frame.html'));
    if (frameUrl.protocol !== 'chrome-extension:' || !frameUrl.hostname) {
      throw new Error('Alpha could not establish its extension origin.');
    }
    return `${frameUrl.protocol}//${frameUrl.host}`;
  }

  function supportedPageOrigin(value) {
    try {
      const parsed = new URL(value);
      return parsed.protocol === 'https:' &&
        !parsed.username &&
        !parsed.password &&
        !parsed.port &&
        SUPPORTED_HOSTS.has(parsed.hostname)
        ? parsed.origin
        : '';
    } catch (_error) {
      return '';
    }
  }

  function envelope(nonce, type, values = {}) {
    return { protocol: PROTOCOL, type, nonce, ...values };
  }

  globalScope.AlphaFrameProtocol = Object.freeze({
    MAX_CONTEXT_CHARACTERS,
    MAX_PROMPT_CHARACTERS,
    PROTOCOL,
    captureTrustedActivation,
    createCacheFingerprint,
    createNonce,
    createRefinementCoordinator,
    createRequestId,
    envelope,
    extensionOrigin,
    hasExactKeys,
    isAuthenticatedParentWindowEvent,
    isAuthenticatedPortEvent,
    isNonce,
    isTrustedUserEvent,
    supportedPageOrigin,
    trustedHandler,
    validateBridgeToFrame,
    validateChannelInit,
    validateFrameToBridge
  });
})(globalThis);
