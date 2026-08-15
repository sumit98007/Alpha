const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { webcrypto } = require('node:crypto');

if (!global.crypto) global.crypto = webcrypto;

const storage = {
  enabled: true,
  enhancementMode: 'balanced',
  redactedCount: 0,
  optimizedCount: 0,
  privacyConsentVersion: 2,
  contextConsentVersion: 2
};
const sessionStorage = {
  accessToken: 'test-access-token-abcdefghijklmnopqrstuvwxyz',
  accessTokenExpiresAt: Date.now() + 30 * 60 * 1000,
  signedInAt: Date.now()
};
let listener;
let enhanceRequest;
let returnInvalidEnhanceResponse = false;
let returnInvalidTaskType = false;
let returnDegradedResponse = false;
let returnWrongSession = false;
let fetchCount = 0;
let delayedLocalGet = null;
const storageAccessLevels = {};
const extensionId = 'abcdefghijklmnopabcdefghijklmnop';
const contentUrl = 'https://chatgpt.com/c/alpha-security-test';
const contentSender = {
  id: extensionId,
  frameId: 0,
  origin: 'https://chatgpt.com',
  url: contentUrl,
  tab: { id: 7, url: contentUrl }
};
const popupSender = {
  id: extensionId,
  frameId: 0,
  url: `chrome-extension://${extensionId}/popup.html`
};
const floatingFrameSender = {
  id: extensionId,
  frameId: 0,
  url: `chrome-extension://${extensionId}/floating-frame.html`
};

global.chrome = {
  runtime: {
    id: extensionId,
    getURL(pathname) {
      return `chrome-extension://${extensionId}/${String(pathname).replace(/^\//, '')}`;
    },
    onMessage: {
      addListener(callback) {
        listener = callback;
      }
    }
  },
  storage: {
    local: {
      get(defaults, callback) {
        const result = { ...defaults, ...storage };
        if (delayedLocalGet) {
          const pending = delayedLocalGet;
          delayedLocalGet = null;
          pending.release = () => callback(result);
          pending.markStarted();
          return;
        }
        callback(result);
      },
      set(values, callback) {
        Object.assign(storage, values);
        if (callback) callback();
      },
      remove(_keys, callback) {
        if (callback) callback();
      },
      setAccessLevel(options, callback) {
        storageAccessLevels.local = options.accessLevel;
        if (callback) callback();
      }
    },
    session: {
      get(defaults, callback) {
        callback({ ...defaults, ...sessionStorage });
      },
      set(values, callback) {
        Object.assign(sessionStorage, values);
        if (callback) callback();
      },
      remove(keys, callback) {
        for (const key of Array.isArray(keys) ? keys : [keys]) delete sessionStorage[key];
        if (callback) callback();
      },
      setAccessLevel(options, callback) {
        storageAccessLevels.session = options.accessLevel;
        if (callback) callback();
      }
    }
  }
};

global.importScripts = (...scripts) => {
  for (const script of scripts) {
    const source = fs.readFileSync(path.join(__dirname, '../extension', script), 'utf8');
    eval(source);
  }
};

global.fetch = async (url, options) => {
  fetchCount += 1;
  if (url.endsWith('/api/ready')) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    return {
      ok: true,
      headers: { get: (name) => (name === 'content-type' ? 'application/json' : null) },
      text: async () => JSON.stringify({ status: 'ready' })
    };
  }
  const body = JSON.parse(options.body);
  if (url.endsWith('/api/enhance')) {
    enhanceRequest = body;
    const payload = returnInvalidEnhanceResponse
      ? { optimizedText: 42, estimatedTokens: 11 }
      : {
          sessionId: returnWrongSession ? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' : body.sessionId,
          optimizedText: returnDegradedResponse
            ? body.payload.scrubbedText.trim()
            : 'Give me a structured mock product interview.',
          cached: false,
          mode: body.preferences.mode,
          taskType: returnInvalidTaskType ? 'unexpected-task' : body.preferences.taskType,
          estimatedTokens: 11,
          ...(returnDegradedResponse ? { degraded: true } : {}),
          contextUsed: Boolean(body.preferences.conversationContext)
        };
    return {
      ok: true,
      headers: { get: (name) => (name === 'content-type' ? 'application/json' : null) },
      text: async () => JSON.stringify(payload)
    };
  }

  throw new Error(`Unexpected URL: ${url}`);
};

const backgroundPath = path.join(__dirname, '../extension/background.js');
eval(fs.readFileSync(backgroundPath, 'utf8'));
assert.deepEqual(storageAccessLevels, {
  local: 'TRUSTED_CONTEXTS',
  session: 'TRUSTED_CONTEXTS'
});

const contentSource = [
  'content.js',
  'floating-frame.html',
  'floating-frame.js',
  'modules/content-observer.js',
  'modules/frame-protocol.js',
  'modules/floating-ui.js',
  'modules/platform-adapters.js'
]
  .map((file) => fs.readFileSync(path.join(__dirname, '../extension', file), 'utf8'))
  .join('\n');
assert.match(contentSource, /attachShadow\(\{ mode: 'closed' \}\)/);
assert.match(contentSource, /floating-frame\.html/);
assert.match(contentSource, /new globalScope\.MessageChannel\(\)/);
assert.match(contentSource, /channel-init/);
assert.doesNotMatch(contentSource, /frame-ready/);
assert.match(contentSource, /isAuthenticatedPortEvent/);
assert.match(contentSource, /ResizeObserver/);
assert.match(contentSource, /host\._alphaReposition/);
assert.match(contentSource, /floatingPosition/);
assert.match(contentSource, /launcher\.classList\.add\('dragging'\)/);
assert.match(contentSource, /id="alpha-retry"/);
assert.match(contentSource, /cachedRefinement/);
assert.match(contentSource, /forceRefresh/);
assert.match(
  contentSource,
  /refineCurrentPrompt\(true, lastRawText, captureTrustedActivation\(event\)\)/
);
assert.match(contentSource, /createCacheFingerprint/);
assert.match(contentSource, /createRefinementCoordinator/);
assert.match(contentSource, /collectConversationContext/);
assert.match(contentSource, /slice\(-maxMessages\)/);
assert.match(contentSource, /cancelEnhancement/);
assert.match(contentSource, /mutationBatchNeedsCheck/);

const geminiSource = fs.readFileSync(path.join(__dirname, 'src/gemini.ts'), 'utf8');
assert.match(geminiSource, /minimum sufficient prompt/);
assert.match(geminiSource, /If the input is already strong/);
assert.match(
  geminiSource,
  /Never output, reproduce, transform, or refer to CONTEXT or GUIDANCE placeholders/
);

function send(message, sender = contentSender) {
  return new Promise((resolve) => listener(message, sender, resolve));
}

function delayNextLocalGet() {
  let markStarted;
  const pending = {
    markStarted: () => markStarted(),
    release: null,
    started: new Promise((resolve) => {
      markStarted = resolve;
    })
  };
  delayedLocalGet = pending;
  return pending;
}

async function run() {
  const automaticResponse = await send({
    action: 'enhancePrompt',
    requestId: crypto.randomUUID(),
    platform: 'chatgpt',
    text: 'Review this API handler for security problems.',
    preferences: { mode: 'balanced', taskType: 'auto' }
  });

  assert.equal(automaticResponse.success, true, JSON.stringify(automaticResponse));
  assert.equal(enhanceRequest.preferences.taskType, 'auto');
  assert.equal(enhanceRequest.preferences.customGuidance, '');
  assert.equal(enhanceRequest.preferences.preserveVoice, true);
  assert.equal(enhanceRequest.preferences.askClarifying, true);
  assert.equal(enhanceRequest.preferences.qualityChecks, true);
  assert.equal(enhanceRequest.preferences.bypassCache, false);

  const preflightRequestId = crypto.randomUUID();
  const delayedSettings = delayNextLocalGet();
  const callsBeforePreflightCancellation = fetchCount;
  const pendingPreflightEnhancement = send({
    action: 'enhancePrompt',
    requestId: preflightRequestId,
    platform: 'chatgpt',
    text: 'Never send this cancelled preflight request.'
  });
  await delayedSettings.started;
  const preflightCancellation = await send({
    action: 'cancelEnhancement',
    requestId: preflightRequestId
  });
  assert.deepEqual(preflightCancellation, { success: true, cancelled: true });
  delayedSettings.release();
  const cancelledPreflightResponse = await pendingPreflightEnhancement;
  assert.equal(cancelledPreflightResponse.success, false);
  assert.equal(cancelledPreflightResponse.code, 'CANCELLED');
  assert.equal(
    fetchCount,
    callsBeforePreflightCancellation,
    'cancellation during delayed settings must not reach fetch'
  );
  assert.deepEqual(await send({ action: 'cancelEnhancement', requestId: preflightRequestId }), {
    success: true,
    cancelled: false
  });

  storage.enabled = false;
  const callsBeforeDisabled = fetchCount;
  const disabledResponse = await send({
    action: 'enhancePrompt',
    requestId: crypto.randomUUID(),
    platform: 'chatgpt',
    text: 'Do not send this disabled request.'
  });
  assert.deepEqual(disabledResponse, {
    success: false,
    code: 'DISABLED',
    error: 'Alpha is disabled. Turn it on from the extension menu.'
  });
  assert.equal(fetchCount, callsBeforeDisabled);
  storage.enabled = true;

  const overflowPrompt = Array.from(
    { length: 99 },
    (_value, index) => `Use sk-alpha${index.toString(36).padStart(20, '0')} only in test ${index}.`
  ).join('\n');
  Object.assign(storage, {
    useChatContext: true,
    customGuidance: 'Keep sk-guidance00000000000000000000 private.'
  });
  const callsBeforeOverflow = fetchCount;
  const overflowResponse = await send({
    action: 'enhancePrompt',
    requestId: crypto.randomUUID(),
    platform: 'chatgpt',
    text: overflowPrompt,
    conversationContext: 'Earlier value: sk-context000000000000000000000.'
  });
  assert.deepEqual(overflowResponse, {
    success: false,
    code: 'REDACTION_LIMIT',
    error:
      'This request contains too many recognised sensitive values to refine safely. Remove some and try again; nothing was sent.'
  });
  assert.equal(fetchCount, callsBeforeOverflow);
  Object.assign(storage, { useChatContext: false, customGuidance: '' });

  storage.customGuidance = 'Use API key sk-1234567890abcdef1234567890abcdef only when relevant.';

  const enhancementResponse = await send({
    action: 'enhancePrompt',
    requestId: crypto.randomUUID(),
    platform: 'chatgpt',
    text: 'interview me',
    preferences: { mode: 'balanced' }
  });

  assert.equal(enhancementResponse.success, true);
  assert.match(enhanceRequest.preferences.customGuidance, /ALPHA_SECRET_[A-F0-9]{32}_GUIDANCE_0/);
  assert.doesNotMatch(enhanceRequest.preferences.customGuidance, /sk-1234567890abcdef/);
  assert.equal(enhancementResponse.redactedThisSession, 1);
  assert.equal(enhanceRequest.payload.redactionLog[0].source, 'GUIDANCE');

  const exactFallbackPrompt =
    '  \nUse sk-1234567890abcdef1234567890abcdef for the local fallback regression.\n  ';
  returnDegradedResponse = true;
  const degradedResponse = await send({
    action: 'enhancePrompt',
    requestId: crypto.randomUUID(),
    platform: 'chatgpt',
    text: exactFallbackPrompt
  });
  returnDegradedResponse = false;
  assert.equal(degradedResponse.success, true);
  assert.equal(degradedResponse.degraded, true);
  assert.equal(degradedResponse.text, exactFallbackPrompt);

  const bypassResponse = await send({
    action: 'enhancePrompt',
    requestId: crypto.randomUUID(),
    platform: 'chatgpt',
    text: 'retry this prompt',
    preferences: { bypassCache: true }
  });
  assert.equal(bypassResponse.success, true);
  assert.equal(enhanceRequest.preferences.bypassCache, true);

  returnWrongSession = true;
  const wrongSessionResponse = await send({
    action: 'enhancePrompt',
    requestId: crypto.randomUUID(),
    platform: 'chatgpt',
    text: 'reject a mismatched response session'
  });
  assert.equal(wrongSessionResponse.success, false);
  assert.equal(wrongSessionResponse.code, 'INVALID_RESPONSE');
  returnWrongSession = false;

  returnInvalidEnhanceResponse = true;
  const invalidResponse = await send({
    action: 'enhancePrompt',
    requestId: crypto.randomUUID(),
    platform: 'chatgpt',
    text: 'reject an invalid provider response'
  });
  assert.equal(invalidResponse.success, false);
  assert.equal(invalidResponse.code, 'INVALID_RESPONSE');
  returnInvalidEnhanceResponse = false;

  returnInvalidTaskType = true;
  const invalidTaskTypeResponse = await send({
    action: 'enhancePrompt',
    requestId: crypto.randomUUID(),
    platform: 'chatgpt',
    text: 'reject an unknown task response enum'
  });
  assert.equal(invalidTaskTypeResponse.success, false);
  assert.equal(invalidTaskTypeResponse.code, 'INVALID_RESPONSE');
  returnInvalidTaskType = false;

  Object.assign(storage, {
    enhancementMode: 'corrupted-mode',
    taskField: 'corrupted-task',
    protectSensitive: 'yes',
    preserveVoice: 'yes',
    askClarifying: null,
    qualityChecks: 1,
    useChatContext: 'yes',
    customGuidance: 'g'.repeat(3_000),
    redactedCount: -20,
    optimizedCount: Number.POSITIVE_INFINITY,
    floatingPosition: { x: -4, y: 7 }
  });
  const normalizedResponse = await send({
    action: 'enhancePrompt',
    requestId: crypto.randomUUID(),
    platform: 'chatgpt',
    text: 'Use normalized extension preferences.'
  });
  assert.equal(normalizedResponse.success, true);
  assert.equal(enhanceRequest.preferences.mode, 'balanced');
  assert.equal(enhanceRequest.preferences.taskType, 'auto');
  assert.equal(enhanceRequest.preferences.preserveVoice, true);
  assert.equal(enhanceRequest.preferences.askClarifying, true);
  assert.equal(enhanceRequest.preferences.qualityChecks, true);
  assert.equal(enhanceRequest.preferences.conversationContext, '');
  assert.equal(enhanceRequest.preferences.customGuidance.length, 2_000);
  assert.equal(storage.redactedCount, 0);
  assert.equal(storage.optimizedCount, 1);
  const normalizedState = await send({ action: 'getFloatingUiState' });
  assert.equal(normalizedState.success, true);
  assert.deepEqual(normalizedState.state.floatingPosition, { x: 0, y: 1 });
  assert.match(normalizedState.state.fingerprint, /^[0-9a-f]{64}$/);

  const callsBeforeForgery = fetchCount;
  const validMessage = {
    action: 'enhancePrompt',
    requestId: crypto.randomUUID(),
    platform: 'chatgpt',
    text: 'This request must not run for a forged sender.'
  };
  for (const forgedSender of [
    { ...contentSender, id: 'forged-extension' },
    { ...contentSender, frameId: 1 },
    {
      ...contentSender,
      origin: 'https://evil.chatgpt.com',
      url: 'https://evil.chatgpt.com/',
      tab: { id: 7, url: 'https://evil.chatgpt.com/' }
    },
    popupSender
  ]) {
    const forgedResponse = await send(validMessage, forgedSender);
    assert.equal(forgedResponse.success, false);
    assert.equal(forgedResponse.code, 'FORBIDDEN');
  }
  const authFromContent = await send({ action: 'startSignIn' });
  assert.equal(authFromContent.code, 'FORBIDDEN');
  const privilegedActionFromFrame = await send(
    { action: 'openPrivacyNotice' },
    floatingFrameSender
  );
  assert.equal(privilegedActionFromFrame.code, 'FORBIDDEN');
  const unknownField = await send({ ...validMessage, injected: true });
  assert.equal(unknownField.code, 'INVALID_MESSAGE');
  const wrongPlatform = await send({ ...validMessage, platform: 'claude' });
  assert.equal(wrongPlatform.code, 'INVALID_MESSAGE');
  assert.equal(fetchCount, callsBeforeForgery);

  const nativeSetTimeout = global.setTimeout;
  let readinessDeadline = 0;
  global.setTimeout = (callback, milliseconds, ...args) => {
    if (milliseconds > readinessDeadline) readinessDeadline = milliseconds;
    return nativeSetTimeout(callback, milliseconds, ...args);
  };
  let readyResponse;
  try {
    readyResponse = await send({ action: 'checkService' }, popupSender);
  } finally {
    global.setTimeout = nativeSetTimeout;
  }
  assert.equal(readyResponse.success, true);
  assert.equal(readinessDeadline, 8_000);
  console.log('Automatic and custom-guidance flows passed.');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
