(function initializeAlphaRuntime(globalScope) {
  'use strict';

  const DEFAULTS = Object.freeze({
    enabled: true,
    enhancementMode: 'balanced',
    taskField: 'auto',
    protectSensitive: true,
    preserveVoice: true,
    askClarifying: true,
    qualityChecks: true,
    useChatContext: false,
    customGuidance: '',
    redactedCount: 0,
    optimizedCount: 0,
    privacyConsentVersion: 0,
    privacyConsentAt: null,
    contextConsentVersion: 0,
    contextConsentAt: null,
    floatingPosition: null
  });

  const CONSENT_VERSION = 2;

  function runtimeError() {
    const error = globalScope.chrome?.runtime?.lastError;
    return error ? new Error(error.message || 'The extension context is unavailable.') : null;
  }

  function areaGet(area, defaults = {}) {
    if (!area) return Promise.resolve({ ...defaults });
    return new Promise((resolve, reject) => {
      area.get(defaults, (result) => {
        const error = runtimeError();
        if (error) reject(error);
        else resolve(result);
      });
    });
  }

  function areaSet(area, values) {
    if (!area) {
      return Promise.reject(new Error('The requested extension storage area is unavailable.'));
    }
    return new Promise((resolve, reject) => {
      area.set(values, () => {
        const error = runtimeError();
        if (error) reject(error);
        else resolve();
      });
    });
  }

  function areaRemove(area, keys) {
    if (!area) {
      return Promise.reject(new Error('The requested extension storage area is unavailable.'));
    }
    return new Promise((resolve, reject) => {
      area.remove(keys, () => {
        const error = runtimeError();
        if (error) reject(error);
        else resolve();
      });
    });
  }

  const storageGet = (defaults) => areaGet(globalScope.chrome.storage.local, defaults);
  const storageSet = (values) => areaSet(globalScope.chrome.storage.local, values);
  const storageRemove = (keys) => areaRemove(globalScope.chrome.storage.local, keys);
  const sessionGet = (defaults) => areaGet(globalScope.chrome.storage.session, defaults);
  const sessionSet = (values) => areaSet(globalScope.chrome.storage.session, values);
  const sessionRemove = (keys) => areaRemove(globalScope.chrome.storage.session, keys);

  function sendMessage(message) {
    return new Promise((resolve, reject) => {
      globalScope.chrome.runtime.sendMessage(message, (response) => {
        const error = runtimeError();
        if (error) reject(error);
        else resolve(response);
      });
    });
  }

  function randomUUID() {
    if (typeof globalScope.crypto?.randomUUID === 'function') {
      return globalScope.crypto.randomUUID();
    }

    if (typeof globalScope.crypto?.getRandomValues !== 'function') {
      throw new Error('Secure random number generation is unavailable.');
    }

    const bytes = new Uint8Array(16);
    globalScope.crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  function normalizeError(error, fallback = 'Alpha is temporarily unavailable.') {
    if (!error) return fallback;
    if (error.name === 'AbortError') return 'The request was cancelled.';
    const message = typeof error.message === 'string' ? error.message.trim() : '';
    return message || fallback;
  }

  globalScope.AlphaRuntime = Object.freeze({
    CONSENT_VERSION,
    DEFAULTS,
    normalizeError,
    randomUUID,
    sessionGet,
    sessionRemove,
    sessionSet,
    sendMessage,
    storageGet,
    storageRemove,
    storageSet
  });
})(globalThis);
