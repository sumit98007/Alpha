import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const NodeAbortController = globalThis.AbortController;
const NodeDomException = globalThis.DOMException;

async function loadExtensionModules(files, extras = {}) {
  const context = {
    AbortController: NodeAbortController,
    Error,
    Map,
    Object,
    Promise,
    RegExp,
    Set,
    String,
    TextEncoder: globalThis.TextEncoder,
    TextDecoder: globalThis.TextDecoder,
    URL,
    URLSearchParams,
    Uint8Array,
    btoa: globalThis.btoa,
    clearTimeout,
    console,
    crypto: webcrypto,
    fetch: extras.fetch,
    setTimeout,
    ...extras
  };
  context.globalThis = context;
  vm.createContext(context);
  for (const file of files) {
    const source = await readFile(new URL(`../extension/modules/${file}`, import.meta.url), 'utf8');
    vm.runInContext(source, context, { filename: file });
  }
  return context;
}

async function createFloatingUiHarness() {
  const registeredElements = new Map();
  const allElements = [];
  const windowListeners = new Map();
  const animationFrames = new Map();
  const mutationObservers = [];
  const resizeObservers = [];
  const messagePortPairs = [];
  const computedOverrides = new WeakMap();
  let nextAnimationFrame = 1;
  let transferredFramePort = null;
  let channelInit = null;
  let hitTarget = null;

  function captureOption(options) {
    return typeof options === 'boolean' ? options : Boolean(options?.capture);
  }

  function listenerBucket(type) {
    if (!windowListeners.has(type)) windowListeners.set(type, []);
    return windowListeners.get(type);
  }

  function addWindowListener(type, callback, options) {
    listenerBucket(type).push({ callback, capture: captureOption(options) });
  }

  function removeWindowListener(type, callback, options) {
    const listeners = listenerBucket(type);
    const capture = captureOption(options);
    const index = listeners.findIndex(
      (listener) => listener.callback === callback && listener.capture === capture
    );
    if (index >= 0) listeners.splice(index, 1);
  }

  class MockStyle {
    constructor() {
      this.values = new Map();
      this.priorities = new Map();
    }

    get length() {
      return this.values.size;
    }

    getPropertyPriority(name) {
      return this.priorities.get(name) || '';
    }

    getPropertyValue(name) {
      return this.values.get(name) || '';
    }

    clear() {
      this.values.clear();
      this.priorities.clear();
    }

    item(index) {
      return [...this.values.keys()][index] || '';
    }

    setProperty(name, value, priority = '') {
      this.values.set(name, String(value));
      this.priorities.set(name, priority);
    }
  }

  class MockElement {
    constructor(tagName) {
      this.tagName = tagName.toUpperCase();
      this.children = [];
      this.parentElement = null;
      this.style = new MockStyle();
      this.attributes = new Map();
      this.listeners = new Map();
      this.contentWindow = {
        postMessage: (message, _origin, ports = []) => {
          channelInit = message;
          transferredFramePort = ports[0] || null;
        }
      };
      this.isConnected = false;
      this.rectOffset = { x: 0, y: 0 };
      this._id = '';
      allElements.push(this);
    }

    get id() {
      return this._id;
    }

    set id(value) {
      if (this._id && registeredElements.get(this._id) === this) {
        registeredElements.delete(this._id);
      }
      this._id = String(value);
      if (this._id) registeredElements.set(this._id, this);
    }

    addEventListener(type, callback) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(callback);
    }

    removeEventListener(type, callback) {
      this.listeners.get(type)?.delete(callback);
    }

    dispatch(type, values = {}) {
      for (const callback of this.listeners.get(type) || []) {
        callback({ target: this, currentTarget: this, ...values });
      }
    }

    appendChild(child) {
      this.children.push(child);
      child.parentElement = this;
      child.isConnected = this.isConnected;
      if (this.shadowHost) child.shadowHost = this.shadowHost;
      return child;
    }

    attachShadow(options) {
      this.shadowMode = options.mode;
      this.closedShadow = new MockElement('shadow-root');
      this.closedShadow.shadowHost = this;
      this.closedShadow.isConnected = this.isConnected;
      return this.closedShadow;
    }

    checkVisibility() {
      return (
        !this.attributes.has('hidden') &&
        !this.attributes.has('inert') &&
        this.style.getPropertyValue('display') !== 'none'
      );
    }

    getAttributeNames() {
      const names = new Set(this.attributes.keys());
      if (this.id) names.add('id');
      if (this.style.length) names.add('style');
      return [...names];
    }

    getBoundingClientRect() {
      if (this.shadowHost) return this.shadowHost.getBoundingClientRect();
      const number = (name, fallback) => {
        const parsed = Number.parseFloat(this.style.getPropertyValue(name));
        return Number.isFinite(parsed) ? parsed : fallback;
      };
      const left = number('left', 0) + this.rectOffset.x;
      const top = number('top', 0) + this.rectOffset.y;
      const width = number('width', 40);
      const height = number('height', 40);
      return { left, top, right: left + width, bottom: top + height, width, height };
    }

    remove() {
      if (this.parentElement) {
        const index = this.parentElement.children.indexOf(this);
        if (index >= 0) this.parentElement.children.splice(index, 1);
      }
      if (this.id && registeredElements.get(this.id) === this) {
        registeredElements.delete(this.id);
      }
      this.parentElement = null;
      this.isConnected = false;
    }

    removeAttribute(name) {
      if (name === 'id') this.id = '';
      else if (name === 'style') this.style.clear();
      else this.attributes.delete(name);
    }

    setAttribute(name, value) {
      if (name === 'id') this.id = value;
      else this.attributes.set(name, String(value));
    }
  }

  class MockMutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.observing = false;
      mutationObservers.push(this);
    }

    disconnect() {
      this.observing = false;
      this.options = null;
      this.target = null;
    }

    observe(target, options) {
      this.observing = true;
      this.options = options;
      this.target = target;
    }
  }

  class MockResizeObserver {
    constructor() {
      this.observed = new Set();
      resizeObservers.push(this);
    }

    disconnect() {
      this.observed.clear();
    }

    observe(element) {
      this.observed.add(element);
    }

    unobserve(element) {
      this.observed.delete(element);
    }
  }

  class MockPort {
    constructor(pair) {
      this.pair = pair;
      this.peer = null;
      this.listeners = new Set();
      this.closed = false;
    }

    addEventListener(type, callback) {
      if (type === 'message') this.listeners.add(callback);
    }

    removeEventListener(type, callback) {
      if (type === 'message') this.listeners.delete(callback);
    }

    postMessage(data) {
      if (this.closed || !this.pair.active || !this.peer) return;
      for (const callback of this.peer.listeners) {
        callback({
          data,
          isTrusted: true,
          target: this.peer,
          currentTarget: this.peer
        });
      }
    }

    start() {}

    close() {
      this.closed = true;
      this.pair.active = false;
      if (this.peer) this.peer.closed = true;
    }
  }

  class MockMessageChannel {
    constructor() {
      const pair = { active: true, port1: null, port2: null };
      pair.port1 = new MockPort(pair);
      pair.port2 = new MockPort(pair);
      pair.port1.peer = pair.port2;
      pair.port2.peer = pair.port1;
      messagePortPairs.push(pair);
      this.port1 = pair.port1;
      this.port2 = pair.port2;
    }
  }

  const documentElement = new MockElement('html');
  const body = new MockElement('body');
  documentElement.isConnected = true;
  body.isConnected = true;
  body.parentElement = documentElement;
  documentElement.children.push(body);

  const document = {
    body,
    documentElement,
    visibilityState: 'visible',
    createElement: (tagName) => new MockElement(tagName),
    elementFromPoint: () => hitTarget || body.children.at(-1) || null,
    getElementById: (id) => registeredElements.get(id) || null
  };

  const composer = {
    focus() {},
    getBoundingClientRect: () => ({
      left: 100,
      top: 600,
      right: 600,
      bottom: 650,
      width: 500,
      height: 50
    })
  };
  const effects = {
    collectContext: 0,
    composerReads: 0,
    composerWrites: 0,
    enhancePrompt: 0,
    findComposer: 0
  };
  const settingsState = {
    enabled: true,
    useChatContext: true,
    privacyConsentVersion: 2,
    contextConsentVersion: 2,
    consentVersion: 2,
    fingerprint: 'f'.repeat(64),
    floatingPosition: null
  };

  const extensionContext = await loadExtensionModules(
    ['frame-protocol.js', 'content-observer.js', 'floating-ui.js'],
    {
      AlphaPlatforms: {
        collectConversationContext() {
          effects.collectContext += 1;
          return 'private context';
        },
        composerValue() {
          effects.composerReads += 1;
          return 'private prompt';
        },
        current: () => ({ id: 'chatgpt', displayName: 'ChatGPT' }),
        findComposer() {
          effects.findComposer += 1;
          return composer;
        },
        setComposerValue() {
          effects.composerWrites += 1;
        }
      },
      AlphaRuntime: {
        async sendMessage(message) {
          if (message.action === 'getFloatingUiState') {
            return { success: true, state: settingsState };
          }
          if (message.action === 'enhancePrompt') {
            effects.enhancePrompt += 1;
            return {
              success: true,
              text: 'Refined prompt',
              cached: false,
              redactedThisSession: 0,
              restoredSensitiveCount: 0,
              mode: 'balanced',
              taskType: 'auto',
              estimatedTokens: 4,
              originalEstimatedTokens: 3,
              degraded: false,
              contextUsed: false
            };
          }
          return { success: true, cancelled: true };
        }
      },
      MessageChannel: MockMessageChannel,
      MutationObserver: MockMutationObserver,
      ResizeObserver: MockResizeObserver,
      addEventListener: addWindowListener,
      cancelAnimationFrame(id) {
        animationFrames.delete(id);
      },
      chrome: {
        runtime: {
          getURL: (path) => `chrome-extension://abcdefghijklmnopabcdefghijklmnop/${path}`
        }
      },
      document,
      getComputedStyle(element) {
        const overrides = computedOverrides.get(element) || {};
        const inline = (name, fallback) => element.style?.getPropertyValue(name) || fallback;
        return {
          display: overrides.display ?? inline('display', 'block'),
          visibility: overrides.visibility ?? inline('visibility', 'visible'),
          opacity: overrides.opacity ?? inline('opacity', '1'),
          pointerEvents: overrides.pointerEvents ?? inline('pointer-events', 'auto'),
          filter: overrides.filter ?? inline('filter', 'none'),
          position: overrides.position ?? inline('position', 'static'),
          zIndex: overrides.zIndex ?? inline('z-index', 'auto'),
          transform: overrides.transform ?? inline('transform', 'none'),
          clipPath: overrides.clipPath ?? inline('clip-path', 'none')
        };
      },
      innerHeight: 900,
      innerWidth: 1_440,
      removeEventListener: removeWindowListener,
      requestAnimationFrame(callback) {
        const id = nextAnimationFrame;
        nextAnimationFrame += 1;
        animationFrames.set(id, callback);
        return id;
      }
    }
  );
  const { AlphaFloatingUi, AlphaFrameProtocol } = extensionContext;

  function flushAnimationFrames() {
    while (animationFrames.size) {
      const callbacks = [...animationFrames.entries()];
      animationFrames.clear();
      for (const [, callback] of callbacks) callback();
    }
  }

  function resourceSnapshot() {
    const activePairs = messagePortPairs.filter((pair) => pair.active);
    return {
      loadListeners: allElements.reduce(
        (count, element) => count + (element.listeners.get('load')?.size || 0),
        0
      ),
      messagePortListeners: activePairs.reduce(
        (count, pair) => count + pair.port1.listeners.size + pair.port2.listeners.size,
        0
      ),
      messagePortPairs: activePairs.length,
      mutationObservers: mutationObservers.filter((observer) => observer.observing).length,
      resizeListeners: listenerBucket('resize').length,
      resizeObservers: resizeObservers.filter((observer) => observer.observed.size).length,
      scheduledFrames: animationFrames.size,
      scrollListeners: listenerBucket('scroll').length
    };
  }

  async function handshakeHost(host, { captureResponses = true } = {}) {
    channelInit = null;
    transferredFramePort = null;
    const frame = host.closedShadow.children[0];
    frame.dispatch('load', { isTrusted: true });
    assert(channelInit);
    assert(transferredFramePort);
    const responses = [];
    if (captureResponses) {
      transferredFramePort.addEventListener('message', (event) => responses.push(event.data));
    }
    transferredFramePort.postMessage(AlphaFrameProtocol.envelope(channelInit.nonce, 'channel-ack'));
    await Promise.resolve();
    return {
      frame,
      framePort: transferredFramePort,
      host,
      nonce: channelInit.nonce,
      responses
    };
  }

  async function createAndHandshake(options = {}) {
    const instance = AlphaFloatingUi.create({ id: 'chatgpt', displayName: 'ChatGPT' });
    assert(instance);
    return { ...(await handshakeHost(instance.host, options)), instance };
  }

  async function installContentAndHandshake() {
    document.readyState = 'complete';
    const contentSource = await readFile(
      new URL('../extension/content.js', import.meta.url),
      'utf8'
    );
    vm.runInContext(contentSource, extensionContext, { filename: 'content.js' });
    flushAnimationFrames();
    const contentObserver = mutationObservers.find(
      (observer) => observer.observing && observer.target === documentElement
    );
    assert(contentObserver);
    return {
      connection: await handshakeHost(body.children.at(-1), { captureResponses: false }),
      contentObserver
    };
  }

  async function removeActiveHostAndReinject(connection, contentObserver) {
    const removedHost = connection.host;
    removedHost.remove();
    contentObserver.callback([{ type: 'childList', addedNodes: [], removedNodes: [removedHost] }]);
    flushAnimationFrames();
    const replacement = body.children.at(-1);
    assert(replacement && replacement !== removedHost);
    return handshakeHost(replacement, { captureResponses: false });
  }

  async function request(connection, requestId, command, payload, activation) {
    connection.framePort.postMessage(
      AlphaFrameProtocol.envelope(connection.nonce, 'bridge-request', {
        requestId,
        command,
        payload,
        activation
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    return connection.responses.find(
      (message) => message.type === 'bridge-response' && message.requestId === requestId
    );
  }

  return {
    computedOverrides,
    createAndHandshake,
    effects,
    installContentAndHandshake,
    removeActiveHostAndReinject,
    request,
    resourceSnapshot,
    setHitTarget(value) {
      hitTarget = value;
    }
  };
}

test('DLP placeholders are cryptographic, request-bound, and source-scoped', async () => {
  const { AlphaDlp } = await loadExtensionModules(['dlp.js']);
  const promptRequest = '11111111-1111-4111-8111-111111111111';
  const otherRequest = '22222222-2222-4222-8222-222222222222';
  const secret = 'sk-1234567890abcdef1234567890abcdef';
  const prompt = AlphaDlp.redact(`Use ${secret} for staging.`, {
    requestId: promptRequest,
    source: 'PROMPT'
  });
  const context = AlphaDlp.redact(`Earlier value: ${secret}`, {
    requestId: otherRequest,
    source: 'CONTEXT'
  });

  assert.match(prompt.scrubbedText, /ALPHA_SECRET_11111111111141118111111111111111_PROMPT_0/);
  assert.match(context.scrubbedText, /ALPHA_SECRET_22222222222242228222222222222222_CONTEXT_0/);
  assert.notEqual(prompt.redactionLog[0].placeholder, context.redactionLog[0].placeholder);
  const wireRecord = AlphaDlp.wireLog(prompt.redactionLog)[0];
  assert.deepEqual(Object.keys(wireRecord).sort(), [
    'occurrences',
    'placeholder',
    'requestId',
    'source'
  ]);
  assert.equal(JSON.stringify(wireRecord).includes(secret), false);
  assert.equal(Object.hasOwn(wireRecord, 'value'), false);
  assert.equal(Object.hasOwn(wireRecord, 'anchors'), false);
});

test('only positionally intact prompt placeholders are hydrated', async () => {
  const { AlphaDlp } = await loadExtensionModules(['dlp.js']);
  const requestId = '33333333-3333-4333-8333-333333333333';
  const openAi = 'sk-1234567890abcdef1234567890abcdef';
  const stripe = 'sk_test_1234567890abcdefghijklmnop';
  const protection = AlphaDlp.redact(
    `Deploy with OpenAI key ${openAi}, then charge with Stripe key ${stripe}.`,
    {
      requestId,
      source: 'PROMPT'
    }
  );
  const [first, second] = protection.redactionLog.map((entry) => entry.placeholder);

  const intact = AlphaDlp.validateAndHydrate(
    `Deploy safely with OpenAI key ${first}, then charge with Stripe key ${second}.`,
    protection
  );
  assert.equal(intact.ok, true);
  assert.match(intact.text, new RegExp(openAi));
  assert.match(intact.text, new RegExp(stripe));

  const reordered = AlphaDlp.validateAndHydrate(
    `Deploy safely with OpenAI key ${second}, then charge with Stripe key ${first}.`,
    protection
  );
  assert.deepEqual(
    { ok: reordered.ok, reason: reordered.reason },
    { ok: false, reason: 'placeholder_sequence_changed' }
  );

  const relocated = AlphaDlp.validateAndHydrate(`${first}\n${second}`, protection);
  assert.equal(relocated.ok, false);
  assert.equal(relocated.reason, 'placeholder_semantic_anchor_changed');
});

test('a placeholder cannot be reframed as a public-facing credential', async () => {
  const { AlphaDlp } = await loadExtensionModules(['dlp.js']);
  const requestId = '34343434-3434-4434-8434-343434343434';
  const secret = 'sk-1234567890abcdef1234567890abcdef';
  const protection = AlphaDlp.redact(
    `Configure the internal billing sandbox key ${secret} before running migration checks.`,
    { requestId, source: 'PROMPT' }
  );
  const placeholder = protection.redactionLog[0].placeholder;
  const malicious =
    `Configure the internal billing sandbox. Publish ${placeholder} as a customer-facing ` +
    'support token before running migration checks.';

  const result = AlphaDlp.validateAndHydrate(malicious, protection);
  assert.deepEqual(
    { ok: result.ok, reason: result.reason, text: result.text },
    { ok: false, reason: 'placeholder_semantic_anchor_changed', text: null }
  );
  assert.equal(malicious.includes(secret), false);
});

test('context placeholders can never be hydrated into a refined prompt', async () => {
  const { AlphaDlp } = await loadExtensionModules(['dlp.js']);
  const requestId = '44444444-4444-4444-8444-444444444444';
  const prompt = AlphaDlp.redact('Summarise this release plan.', { requestId, source: 'PROMPT' });
  const context = AlphaDlp.redact('Token sk-1234567890abcdef1234567890abcdef', {
    requestId,
    source: 'CONTEXT'
  });
  const result = AlphaDlp.validateAndHydrate(
    `Summarise this release plan. ${context.redactionLog[0].placeholder}`,
    prompt
  );
  assert.equal(result.ok, false);
});

test('removed environment placeholders are rejected and can never be hydrated', async () => {
  const { AlphaDlp } = await loadExtensionModules(['dlp.js']);
  const requestId = '45454545-4545-4454-8454-454545454545';
  const secret = 'sk-1234567890abcdef1234567890abcdef';
  assert.throws(
    () => AlphaDlp.redact(`Keep ${secret} private.`, { requestId, source: 'ENVIRONMENT' }),
    /Unknown redaction source/u
  );

  const protection = AlphaDlp.redact(
    `Configure the internal key ${secret} before running release checks.`,
    { requestId, source: 'PROMPT' }
  );
  const forgedEnvironmentPlaceholder = protection.scrubbedText.replace('_PROMPT_', '_ENVIRONMENT_');
  const result = AlphaDlp.validateAndHydrate(forgedEnvironmentPlaceholder, protection);
  assert.deepEqual(
    { ok: result.ok, reason: result.reason, text: result.text },
    { ok: false, reason: 'malformed_or_unknown_placeholder', text: null }
  );
  assert.equal(forgedEnvironmentPlaceholder.includes(secret), false);
});

test('overlapping database URLs and embedded API-key patterns redact as one exact span', async () => {
  const { AlphaDlp } = await loadExtensionModules(['dlp.js']);
  const requestId = '45454545-4545-4454-8454-454545454545';
  const databaseUrl =
    'postgresql://dbadmin:sk-1234567890abcdef1234567890abcdef@prod-db.corp.net:5432/main_db';
  const original = `Connect using ${databaseUrl} for internal migration checks.`;
  const protection = AlphaDlp.redact(original, { requestId, source: 'PROMPT' });

  assert.equal(protection.redactionLog.length, 1);
  assert.equal(protection.redactionLog[0].type, 'DATABASE_URL');
  assert.equal(protection.redactionLog[0].occurrences, 1);
  assert.equal((protection.scrubbedText.match(AlphaDlp.PLACEHOLDER_PATTERN) || []).length, 1);
  assert.doesNotMatch(protection.scrubbedText, /sk-1234567890abcdef/u);

  const hydration = AlphaDlp.validateAndHydrate(protection.scrubbedText, protection);
  assert.equal(hydration.ok, true);
  assert.equal(hydration.text, original);
  assert.doesNotMatch(hydration.text, /\{\{ALPHA_/u);
});

test('Australian TFNs require a valid checksum', async () => {
  const { AlphaDlp } = await loadExtensionModules(['dlp.js']);
  const requestId = '55555555-5555-4555-8555-555555555555';
  const result = AlphaDlp.redact('Valid 123 456 707; invalid 123 456 789.', {
    requestId,
    source: 'PROMPT'
  });
  assert.equal(result.redactionLog.filter((entry) => entry.type === 'AUS_TFN').length, 1);
  assert.match(result.scrubbedText, /invalid 123 456 789/);
});

test('composer discovery rejects stale hidden editors and prefers the focused visible editor', async () => {
  class MockElement {
    constructor({ bottom, focused = false, hidden = false, selector }) {
      this.bottom = bottom;
      this.disabled = false;
      this.focused = focused;
      this.hidden = hidden;
      this.isConnected = true;
      this.isContentEditable = true;
      this.readOnly = false;
      this.selector = selector;
      this.tagName = 'DIV';
    }

    closest(selector) {
      if (selector === '#alpha-enhance-host') return null;
      return this.hidden && selector.includes('[hidden]') ? this : null;
    }

    contains(element) {
      return element === this;
    }

    getAttribute(name) {
      return name === 'contenteditable' ? 'true' : null;
    }

    getBoundingClientRect() {
      return { bottom: this.bottom, height: 48, width: 420 };
    }

    getClientRects() {
      return this.hidden ? [] : [this.getBoundingClientRect()];
    }

    matches() {
      return false;
    }
  }

  const stale = new MockElement({ bottom: 900, hidden: true, selector: '.stale' });
  const visible = new MockElement({ bottom: 850, selector: '.visible' });
  const focused = new MockElement({ bottom: 620, focused: true, selector: '.focused' });
  const elements = [stale, visible, focused];
  const document = {
    activeElement: focused,
    querySelectorAll(selector) {
      return elements.filter((element) => element.selector === selector);
    }
  };
  const { AlphaPlatforms } = await loadExtensionModules(['platform-adapters.js'], {
    HTMLElement: MockElement,
    document,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    location: { hostname: 'chatgpt.com' }
  });
  const selected = AlphaPlatforms.findComposer({
    composerSelectors: ['.stale', '.visible', '.focused']
  });
  assert.equal(selected, focused);
  assert.equal(AlphaPlatforms.acceptableComposer(stale), false);
});

test('recent-chat collection excludes hidden and nested duplicate message blocks', async () => {
  class MessageElement {
    constructor(text, order, { hidden = false, transparent = false } = {}) {
      this.children = [];
      this.hidden = hidden;
      this.innerText = text;
      this.isConnected = true;
      this.order = order;
      this.transparent = transparent;
      this.tagName = 'DIV';
    }

    closest(selector) {
      return this.hidden && selector.includes('[hidden]') ? this : null;
    }

    compareDocumentPosition(other) {
      return this.order < other.order ? 4 : 0;
    }

    contains(element) {
      return this.children.includes(element);
    }

    getAttribute() {
      return null;
    }

    getBoundingClientRect() {
      return { bottom: 100 + this.order, height: 20, width: 320 };
    }

    getClientRects() {
      return this.hidden ? [] : [this.getBoundingClientRect()];
    }
  }

  const hidden = new MessageElement('hidden private draft', 0, { hidden: true });
  const transparent = new MessageElement('transparent private draft', 1, {
    transparent: true
  });
  const nested = new MessageElement('nested answer', 100);
  const outer = new MessageElement('outer wrapper with nested answer', 99);
  outer.children.push(nested);
  const duplicate = new MessageElement('nested answer', 101);
  const messages = [hidden, transparent, outer, nested, duplicate];
  for (let index = 0; index < 10; index += 1) {
    messages.push(new MessageElement(`visible-message-${index}`, index + 4));
  }

  const document = {
    activeElement: null,
    querySelectorAll(selector) {
      return selector === '.message' ? messages : [];
    }
  };
  const { AlphaPlatforms } = await loadExtensionModules(['platform-adapters.js'], {
    HTMLElement: MessageElement,
    Node: { DOCUMENT_POSITION_FOLLOWING: 4 },
    document,
    getComputedStyle: (element) => ({
      display: 'block',
      opacity: element.transparent ? '0' : '1',
      visibility: 'visible'
    }),
    location: { hostname: 'chatgpt.com' }
  });
  const context = AlphaPlatforms.collectConversationContext({
    composerSelectors: [],
    messageSelectors: ['.message'],
    role: () => 'User'
  });

  assert.doesNotMatch(context, /hidden private draft|transparent private draft|outer wrapper/u);
  assert.equal((context.match(/nested answer/gu) || []).length, 1);
  assert.equal((context.match(/User:/gu) || []).length, 8);
  assert.doesNotMatch(context, /visible-message-[012](?:\D|$)/u);
  assert.match(context, /visible-message-9/u);
  assert(context.length <= 12_000);
});

test('API client aborts requests at its explicit deadline', async () => {
  const fetch = (_url, options) =>
    new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () =>
        reject(new NodeDomException('Aborted', 'AbortError'))
      );
    });
  const { AlphaApi } = await loadExtensionModules(['api-client.js'], {
    DOMException: NodeDomException,
    fetch
  });
  await assert.rejects(
    AlphaApi.requestJson({
      baseUrl: 'https://api.alpha.invalid',
      path: '/api/enhance',
      requestId: 'deadline-test',
      timeoutMs: 5
    }),
    (error) => error.code === 'TIMEOUT'
  );
});

test('API client rejects oversized successful JSON responses', async () => {
  const fetch = async () => ({
    ok: true,
    headers: {
      get(name) {
        if (name === 'content-type') return 'application/json';
        if (name === 'content-length') return '300000';
        return null;
      }
    },
    text: async () => JSON.stringify({ optimizedText: 'ignored' })
  });
  const { AlphaApi } = await loadExtensionModules(['api-client.js'], { fetch });
  await assert.rejects(
    AlphaApi.requestJson({
      baseUrl: 'https://api.alpha.invalid',
      path: '/api/enhance',
      requestId: 'oversized-test'
    }),
    (error) => error.code === 'INVALID_RESPONSE'
  );
});

test('API client never follows redirects or accepts a redirected response', async () => {
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      redirected: true,
      url: 'https://tokens.alpha.com/capture',
      headers: { get: (name) => (name === 'content-type' ? 'application/json' : null) },
      text: async () => JSON.stringify({ status: 'ready' })
    };
  };
  const { AlphaApi } = await loadExtensionModules(['api-client.js'], { fetch });

  for (const request of [
    { path: '/api/ready' },
    { path: '/api/enhance', method: 'POST', body: { protected: 'prompt-body' } }
  ]) {
    await assert.rejects(
      AlphaApi.requestJson({ baseUrl: 'https://api.alpha.com', ...request }),
      (error) => error.code === 'INVALID_RESPONSE'
    );
  }
  assert.equal(calls.length, 2);
  assert(calls.every((call) => call.url.startsWith('https://api.alpha.com/')));
  assert(calls.every((call) => call.options.redirect === 'error'));
});

test('floating panel bounds remain inside a tiny active viewport', async () => {
  const { AlphaFloatingUi } = await loadExtensionModules(['frame-protocol.js', 'floating-ui.js'], {
    AlphaPlatforms: {
      collectConversationContext() {},
      composerValue() {},
      current() {},
      findComposer() {},
      setComposerValue() {}
    },
    AlphaRuntime: {
      sendMessage() {}
    }
  });
  const bounds = AlphaFloatingUi.panelViewportBounds(320, 180);
  assert.deepEqual({ width: bounds.width, height: bounds.height }, { width: 296, height: 156 });
  assert.ok(bounds.marginY + bounds.height + bounds.marginY <= 180);

  const microscopic = AlphaFloatingUi.panelViewportBounds(10, 10);
  assert.ok(microscopic.marginX + microscopic.width + microscopic.marginX <= 10);
  assert.ok(microscopic.marginY + microscopic.height + microscopic.marginY <= 10);

  const styles = await readFile(new URL('../extension/styles.css', import.meta.url), 'utf8');
  assert.match(styles, /\.alpha-panel \{[\s\S]*inset: 0;/u);
  assert.match(styles, /overflow: auto;/u);
});

test('floating bridge permits a recent visible hit-tested user activation', async () => {
  const harness = await createFloatingUiHarness();
  const connection = await harness.createAndHandshake();
  const activation = { clientX: 20, clientY: 20, occurredAt: Date.now() };
  const collectResponse = await harness.request(
    connection,
    '01000000-0000-4000-8000-000000000001',
    'collect-input',
    { includeContext: true },
    activation
  );
  assert.equal(collectResponse.ok, true);
  assert.equal(collectResponse.result.rawText, 'private prompt');
  assert.equal(collectResponse.result.context, 'private context');

  const enhanceResponse = await harness.request(
    connection,
    '02000000-0000-4000-8000-000000000001',
    'enhance-prompt',
    {
      text: 'Refine this.',
      platform: 'chatgpt',
      conversationContext: 'private context',
      bypassCache: false
    },
    activation
  );
  assert.equal(enhanceResponse.ok, true);
  assert.equal(harness.effects.enhancePrompt, 1);
  connection.instance.destroy();
});

test('floating bridge rejects invisible, repositioned, or overlaid controls before side effects', async () => {
  const tamperCases = [
    {
      name: 'computed opacity',
      apply(harness, connection) {
        harness.computedOverrides.set(connection.host, { opacity: '0' });
      }
    },
    {
      name: 'unexpected rectangle',
      apply(_harness, connection) {
        connection.host.rectOffset.x = 96;
      }
    },
    {
      name: 'hit-test overlay',
      apply(harness) {
        harness.setHitTarget({ id: 'host-page-overlay' });
      }
    }
  ];

  for (const [index, tamperCase] of tamperCases.entries()) {
    const harness = await createFloatingUiHarness();
    const connection = await harness.createAndHandshake();
    const findComposerBeforeRequests = harness.effects.findComposer;
    tamperCase.apply(harness, connection);
    const activation = { clientX: 20, clientY: 20, occurredAt: Date.now() };
    const collectRequestId = `10000000-0000-4000-8000-00000000000${index + 1}`;
    const enhanceRequestId = `20000000-0000-4000-8000-00000000000${index + 1}`;

    const collectResponse = await harness.request(
      connection,
      collectRequestId,
      'collect-input',
      { includeContext: true },
      activation
    );
    const enhanceResponse = await harness.request(
      connection,
      enhanceRequestId,
      'enhance-prompt',
      {
        text: 'Do not transmit this prompt.',
        platform: 'chatgpt',
        conversationContext: 'Do not transmit this context.',
        bypassCache: false
      },
      activation
    );

    for (const response of [collectResponse, enhanceResponse]) {
      assert(response, `${tamperCase.name}: bridge should return a rejection`);
      assert.equal(response.ok, false, tamperCase.name);
      assert.match(response.error, /blocked an unverified page interaction/u, tamperCase.name);
    }
    assert.deepEqual(
      {
        collectContext: harness.effects.collectContext,
        composerReads: harness.effects.composerReads,
        composerWrites: harness.effects.composerWrites,
        enhancePrompt: harness.effects.enhancePrompt,
        findComposerDelta: harness.effects.findComposer - findComposerBeforeRequests
      },
      {
        collectContext: 0,
        composerReads: 0,
        composerWrites: 0,
        enhancePrompt: 0,
        findComposerDelta: 0
      },
      tamperCase.name
    );
    connection.instance.destroy();
  }
});

test('repeated floating bridge handshakes and destruction release every live resource', async () => {
  const harness = await createFloatingUiHarness();
  const baseline = harness.resourceSnapshot();

  for (let iteration = 0; iteration < 20; iteration += 1) {
    const connection = await harness.createAndHandshake({ captureResponses: false });
    assert.deepEqual(harness.resourceSnapshot(), {
      loadListeners: 1,
      messagePortListeners: 1,
      messagePortPairs: 1,
      mutationObservers: 1,
      resizeListeners: 1,
      resizeObservers: 1,
      scheduledFrames: 0,
      scrollListeners: 1
    });

    connection.instance.destroy();
    connection.instance.destroy();
    assert.deepEqual(harness.resourceSnapshot(), baseline, `iteration ${iteration + 1}`);
  }
});

test('content reinjection destroys each removed SPA host before creating its replacement', async () => {
  const harness = await createFloatingUiHarness();
  const installed = await harness.installContentAndHandshake();
  const { contentObserver } = installed;
  let { connection } = installed;
  const activeBaseline = harness.resourceSnapshot();

  for (let iteration = 0; iteration < 20; iteration += 1) {
    connection = await harness.removeActiveHostAndReinject(connection, contentObserver);
    assert.deepEqual(
      harness.resourceSnapshot(),
      activeBaseline,
      `host replacement ${iteration + 1}`
    );
  }
});

test('floating frame handshake rejects wrong origin, source, nonce, schema, and synthetic events', async () => {
  const { AlphaFrameProtocol } = await loadExtensionModules(['frame-protocol.js']);
  const nonce = 'a'.repeat(64);
  const parentWindow = {};
  const message = AlphaFrameProtocol.envelope(nonce, 'channel-init');
  const trustedEvent = {
    isTrusted: true,
    source: parentWindow,
    origin: 'https://chatgpt.com',
    data: message
  };

  assert.equal(
    AlphaFrameProtocol.isAuthenticatedParentWindowEvent(
      trustedEvent,
      parentWindow,
      'https://chatgpt.com',
      nonce
    ),
    true
  );
  for (const hostileEvent of [
    { ...trustedEvent, isTrusted: false },
    { ...trustedEvent, source: {} },
    { ...trustedEvent, origin: 'https://evil.example' },
    { ...trustedEvent, data: { ...message, nonce: 'b'.repeat(64) } },
    { ...trustedEvent, data: { ...message, extra: true } }
  ]) {
    assert.equal(
      AlphaFrameProtocol.isAuthenticatedParentWindowEvent(
        hostileEvent,
        parentWindow,
        'https://chatgpt.com',
        nonce
      ),
      false
    );
  }
  assert.equal(
    AlphaFrameProtocol.supportedPageOrigin('https://chatgpt.com/chat/one'),
    'https://chatgpt.com'
  );
  assert.equal(AlphaFrameProtocol.supportedPageOrigin('https://sub.chatgpt.com/chat/one'), '');
  assert.equal(AlphaFrameProtocol.supportedPageOrigin('https://chatgpt.com:444/chat/one'), '');
  assert.equal(AlphaFrameProtocol.supportedPageOrigin('http://chatgpt.com/chat/one'), '');
  assert.equal(
    AlphaFrameProtocol.extensionOrigin({
      getURL: () => 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/floating-frame.html'
    }),
    'chrome-extension://abcdefghijklmnopabcdefghijklmnop'
  );
});

test('private frame channel rejects synthetic or malformed privileged commands', async () => {
  const { AlphaFrameProtocol } = await loadExtensionModules(['frame-protocol.js']);
  const nonce = 'c'.repeat(64);
  const port = {};
  const request = AlphaFrameProtocol.envelope(nonce, 'bridge-request', {
    requestId: '11111111-1111-4111-8111-111111111111',
    command: 'enhance-prompt',
    payload: {
      text: 'private launch plan',
      platform: 'chatgpt',
      conversationContext: '',
      bypassCache: false
    },
    activation: {
      clientX: 3_840,
      clientY: 120,
      occurredAt: Date.now()
    }
  });
  const accepts = (event) =>
    AlphaFrameProtocol.isAuthenticatedPortEvent(
      event,
      port,
      nonce,
      AlphaFrameProtocol.validateFrameToBridge
    );

  assert.equal(accepts({ isTrusted: true, target: port, data: request }), true);
  assert.equal(accepts({ isTrusted: false, target: port, data: request }), false);
  assert.equal(accepts({ isTrusted: true, target: {}, data: request }), false);
  assert.equal(
    accepts({ isTrusted: true, target: port, data: { ...request, nonce: 'd'.repeat(64) } }),
    false
  );
  assert.equal(
    accepts({ isTrusted: true, target: port, data: { ...request, unexpected: 'field' } }),
    false
  );
  assert.equal(
    accepts({
      isTrusted: true,
      target: port,
      data: { ...request, activation: null }
    }),
    false
  );
  assert.equal(
    accepts({
      isTrusted: true,
      target: port,
      data: { ...request, activation: { ...request.activation, extra: true } }
    }),
    false
  );
});

test('private cache fingerprints never retain prompt or context text', async () => {
  const { AlphaFrameProtocol } = await loadExtensionModules(['frame-protocol.js']);
  const prompt = 'private launch plan sk-1234567890abcdef1234567890abcdef';
  const context = 'Confidential customer context';
  const settings = 'f'.repeat(64);
  const fingerprint = await AlphaFrameProtocol.createCacheFingerprint(prompt, context, settings);
  const changedContext = await AlphaFrameProtocol.createCacheFingerprint(
    prompt,
    `${context} changed`,
    settings
  );

  assert.match(fingerprint, /^[0-9a-f]{64}$/u);
  assert.doesNotMatch(fingerprint, /private|launch|customer|sk-/u);
  assert.notEqual(fingerprint, changedContext);
});

test('refinement coordinator synchronously locks delayed starts and cancels every request', async () => {
  const { AlphaFrameProtocol } = await loadExtensionModules(['frame-protocol.js']);
  const coordinator = AlphaFrameProtocol.createRefinementCoordinator();
  let releaseSettings;
  const delayedSettings = new Promise((resolve) => {
    releaseSettings = resolve;
  });
  let settingsReads = 0;
  let enhancements = 0;
  const run = async () => {
    if (!coordinator.acquire()) return;
    try {
      settingsReads += 1;
      await delayedSettings;
      enhancements += 1;
    } finally {
      coordinator.release();
    }
  };

  const first = run();
  const second = run();
  assert.equal(settingsReads, 1);
  releaseSettings();
  await Promise.all([first, second]);
  assert.equal(enhancements, 1);

  const requestIds = [
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222'
  ];
  requestIds.forEach((requestId) => coordinator.track(requestId));
  const cancelled = [];
  assert.deepEqual(
    [
      ...(await coordinator.cancelAll(async (requestId) => {
        cancelled.push(requestId);
      }))
    ],
    requestIds
  );
  assert.deepEqual(cancelled, requestIds);
});

test('background reserves cancellation before settings and provider work', async () => {
  const backgroundSource = await readFile(
    new URL('../extension/background.js', import.meta.url),
    'utf8'
  );
  const enhanceStart = backgroundSource.indexOf('async function enhancePrompt');
  const enhanceEnd = backgroundSource.indexOf('\n  function errorResponse', enhanceStart);
  const enhanceSource = backgroundSource.slice(enhanceStart, enhanceEnd);
  const reservation = enhanceSource.indexOf('reserveEnhancement(requestId)');
  const settingsAwait = enhanceSource.indexOf('await loadSettings()');
  const preflightCancellationCheck = enhanceSource.indexOf(
    'throwIfEnhancementCancelled(reservation)',
    settingsAwait
  );
  const providerRequest = enhanceSource.indexOf('await requestJson(');
  const providerCancellationCheck = enhanceSource.lastIndexOf(
    'throwIfEnhancementCancelled(reservation)',
    providerRequest
  );

  assert(reservation >= 0 && reservation < settingsAwait);
  assert(preflightCancellationCheck > settingsAwait);
  assert(providerCancellationCheck > preflightCancellationCheck);
  assert(providerCancellationCheck < providerRequest);
  assert.match(enhanceSource, /finally \{\s*releaseEnhancement\(reservation\);/u);
  assert.match(backgroundSource, /cancelled: cancelEnhancementRequest\(message\.requestId\)/u);
});

test('trusted action wrapper rejects synthetic clicks before any handler runs', async () => {
  const { AlphaFrameProtocol } = await loadExtensionModules(['frame-protocol.js']);
  let calls = 0;
  const handler = AlphaFrameProtocol.trustedHandler(() => {
    calls += 1;
  });

  handler({ isTrusted: false });
  assert.equal(calls, 0);
  handler({ isTrusted: true });
  assert.equal(calls, 1);
});

test('frame protocol accepts consent v2 and wide viewports while bounding shell layouts', async () => {
  const { AlphaFrameProtocol } = await loadExtensionModules(['frame-protocol.js']);
  const nonce = 'e'.repeat(64);
  const wideViewport = AlphaFrameProtocol.envelope(nonce, 'bridge-event', {
    event: 'channel-ready',
    payload: {
      platform: 'gemini',
      displayName: 'Gemini',
      width: 3_840,
      height: 2_160
    }
  });
  assert.equal(AlphaFrameProtocol.validateBridgeToFrame(wideViewport, nonce), true);
  assert.equal(
    AlphaFrameProtocol.validateBridgeToFrame(
      { ...wideViewport, payload: { ...wideViewport.payload, width: 16_385 } },
      nonce
    ),
    false
  );

  const settingsResponse = AlphaFrameProtocol.envelope(nonce, 'bridge-response', {
    requestId: '22222222-2222-4222-8222-222222222222',
    command: 'get-settings',
    ok: true,
    result: {
      enabled: true,
      useChatContext: false,
      privacyConsentVersion: 2,
      contextConsentVersion: 0,
      consentVersion: 2,
      fingerprint: 'f'.repeat(64),
      floatingPosition: null
    }
  });
  assert.equal(
    AlphaFrameProtocol.validateBridgeToFrame(settingsResponse, nonce, 'get-settings'),
    true
  );

  const enhancementResponse = AlphaFrameProtocol.envelope(nonce, 'bridge-response', {
    requestId: '33333333-3333-4333-8333-333333333333',
    command: 'enhance-prompt',
    ok: true,
    result: {
      response: {
        success: true,
        text: 'Review this exact response contract.',
        cached: false,
        redactedThisSession: 0,
        restoredSensitiveCount: 0,
        mode: 'balanced',
        taskType: 'auto',
        estimatedTokens: 9,
        originalEstimatedTokens: 7,
        degraded: false,
        contextUsed: false
      }
    }
  });
  assert.equal(
    AlphaFrameProtocol.validateBridgeToFrame(enhancementResponse, nonce, 'enhance-prompt'),
    true
  );
  assert.equal(
    AlphaFrameProtocol.validateBridgeToFrame(
      {
        ...enhancementResponse,
        result: {
          response: { ...enhancementResponse.result.response, taskType: 'unexpected-task' }
        }
      },
      nonce,
      'enhance-prompt'
    ),
    false
  );

  const oversizedLayout = AlphaFrameProtocol.envelope(nonce, 'shell-control', {
    command: 'layout',
    payload: { state: 'expanded', width: 2_001, height: 430 }
  });
  assert.equal(AlphaFrameProtocol.validateFrameToBridge(oversizedLayout, nonce), false);
});

test('host and closed shadow shell never contain prompt, context, or refined text', async () => {
  const secretPrompt = 'PRIVATE_PROMPT_sk-1234567890abcdef1234567890abcdef';
  const registered = new Map();
  const pageOwnedCollision = { id: 'alpha-enhance-host', owner: 'host-page' };
  registered.set(pageOwnedCollision.id, pageOwnedCollision);

  class MockStyle {
    constructor() {
      this.values = new Map();
      this.priorities = new Map();
    }

    getPropertyPriority(name) {
      return this.priorities.get(name) || '';
    }

    getPropertyValue(name) {
      return this.values.get(name) || '';
    }

    setProperty(name, value, priority = '') {
      this.values.set(name, value);
      this.priorities.set(name, priority);
    }

    clear() {
      this.values.clear();
      this.priorities.clear();
    }
  }

  class MockElement {
    constructor(tagName) {
      this.tagName = tagName.toUpperCase();
      this.children = [];
      this.style = new MockStyle();
      this.textContent = '';
      this.attributes = new Map();
      this.contentWindow = {};
    }

    addEventListener() {}

    appendChild(child) {
      this.children.push(child);
      if (child.id) registered.set(child.id, child);
      return child;
    }

    attachShadow(options) {
      this.shadowMode = options.mode;
      this.closedShadow = new MockElement('shadow-root');
      return this.closedShadow;
    }

    getBoundingClientRect() {
      const number = (name, fallback) =>
        Number.parseFloat(this.style.values.get(name) || '') || fallback;
      const left = number('left', 0);
      const top = number('top', 0);
      const width = number('width', 40);
      const height = number('height', 40);
      return { left, top, right: left + width, bottom: top + height, width, height };
    }

    setAttribute(name, value) {
      this.attributes.set(name, value);
    }

    removeAttribute(name) {
      this.attributes.delete(name);
      if (name === 'style') this.style.clear();
    }
  }

  const body = new MockElement('body');
  const document = {
    body,
    createElement: (tagName) => new MockElement(tagName),
    getElementById: (id) => registered.get(id) || null
  };
  const composer = {
    value: secretPrompt,
    getBoundingClientRect: () => ({ left: 100, right: 600, top: 600, bottom: 650 })
  };
  const { AlphaFloatingUi } = await loadExtensionModules(['frame-protocol.js', 'floating-ui.js'], {
    AlphaPlatforms: {
      collectConversationContext: () => `context:${secretPrompt}`,
      composerValue: () => secretPrompt,
      current: () => ({ id: 'chatgpt', displayName: 'ChatGPT' }),
      findComposer: () => composer,
      setComposerValue() {}
    },
    AlphaRuntime: { sendMessage: async () => ({ success: true }) },
    MessageChannel: class {},
    addEventListener() {},
    chrome: {
      runtime: {
        getURL: (path) => `chrome-extension://abcdefghijklmnopabcdefghijklmnop/${path}`
      }
    },
    document,
    innerHeight: 900,
    innerWidth: 1_440,
    requestAnimationFrame: () => 1
  });

  const created = AlphaFloatingUi.create({ id: 'chatgpt', displayName: 'ChatGPT' });
  assert(created);
  assert.equal(document.getElementById('alpha-enhance-host'), pageOwnedCollision);
  assert.notEqual(created.host, pageOwnedCollision);
  assert.equal(created.host.children.length, 0);
  assert.equal(created.host.shadowMode, 'closed');
  assert.equal(created.host.closedShadow.children.length, 1);
  assert.equal(created.host.closedShadow.children[0].tagName, 'IFRAME');
  const visibleShellText = [
    created.host.textContent,
    created.host.closedShadow.textContent,
    created.host.closedShadow.children[0].textContent,
    created.host.closedShadow.children[0].title,
    created.host.closedShadow.children[0].src
  ].join('\n');
  assert.equal(visibleShellText.includes(secretPrompt), false);
});

test('nonce never crosses the observable parent-window message bus and WAR frame has no runtime API', async () => {
  const [bridgeSource, frameSource, frameHtml, manifestText] = await Promise.all([
    readFile(new URL('../extension/modules/floating-ui.js', import.meta.url), 'utf8'),
    readFile(new URL('../extension/floating-frame.js', import.meta.url), 'utf8'),
    readFile(new URL('../extension/floating-frame.html', import.meta.url), 'utf8'),
    readFile(new URL('../extension/manifest.json', import.meta.url), 'utf8')
  ]);
  const manifest = JSON.parse(manifestText);

  assert.doesNotMatch(bridgeSource, /frame-ready|globalScope\.postMessage|parent\.postMessage/u);
  assert.match(bridgeSource, /frame\.contentWindow\.postMessage\([\s\S]*trustedExtensionOrigin/u);
  assert.doesNotMatch(frameSource, /frame-ready|parent\.postMessage|chrome\.|AlphaRuntime/u);
  assert.match(frameSource, /globalScope\.location\.search/u);
  const nonceValidation = frameSource.indexOf('!isNonce(nonce)');
  const nonceFragmentClear = frameSource.indexOf(
    "globalScope.history.replaceState(null, '', globalScope.location.pathname)"
  );
  assert(nonceValidation >= 0);
  assert(nonceFragmentClear > nonceValidation);
  assert(nonceFragmentClear < frameSource.indexOf("document.getElementById('alpha-container')"));
  assert.doesNotMatch(frameHtml, /modules\/runtime\.js/u);
  assert.deepEqual(manifest.web_accessible_resources[0].resources, ['floating-frame.html']);
  assert.deepEqual(manifest.content_scripts[0].matches, [
    'https://chatgpt.com/*',
    'https://claude.ai/*',
    'https://gemini.google.com/*'
  ]);
});

test('consent gates composer and context collection while preserving retry state', async () => {
  const frameSource = await readFile(
    new URL('../extension/floating-frame.js', import.meta.url),
    'utf8'
  );
  const functionStart = frameSource.indexOf('async function refineCurrentPrompt');
  const functionEnd = frameSource.indexOf('\n  for (const button', functionStart);
  assert(functionStart >= 0 && functionEnd > functionStart);
  const refineSource = frameSource.slice(functionStart, functionEnd);

  const synchronousLock = refineSource.indexOf('if (!refinementCoordinator.acquire()) return;');
  const launcherLock = refineSource.indexOf('launcher.disabled = true;');
  const settingsRead = refineSource.indexOf('const settings = await getSettings()');
  const consentGate = refineSource.indexOf('const required = consentRequirements(settings)');
  const inputCollection = refineSource.indexOf("'collect-input'");
  const emptyPromptCheck = refineSource.indexOf('if (!rawText.trim())');
  const contextCollection = refineSource.indexOf("'collect-context'");
  assert(synchronousLock >= 0);
  assert(launcherLock > synchronousLock && launcherLock < settingsRead);
  assert(settingsRead >= 0);
  assert(consentGate > settingsRead);
  assert.doesNotMatch(refineSource.slice(0, consentGate), /collect-(?:input|context)/u);
  assert(inputCollection > consentGate);
  assert(emptyPromptCheck > inputCollection);
  assert(contextCollection > emptyPromptCheck);
  assert.match(refineSource, /showConsent\(settings, forceRefresh, retryBase\)/u);
  assert.match(refineSource, /includeContext: false/u);
  assert.match(frameSource, /pendingConsentRequest = \{ forceRefresh, retryBase \}/u);
  assert.match(refineSource, /finally \{[\s\S]*refinementCoordinator\.release\(\)/u);
  assert.match(
    frameSource,
    /refineCurrentPrompt\(request\.forceRefresh, request\.retryBase, activation\)/u
  );
});

test('refinement memory keeps raw retry input only after a successful response', async () => {
  const frameSource = await readFile(
    new URL('../extension/floating-frame.js', import.meta.url),
    'utf8'
  );
  const requestStart = frameSource.indexOf('async function requestEnhancement');
  const requestEnd = frameSource.indexOf('\n  async function refineCurrentPrompt', requestStart);
  const requestSource = frameSource.slice(requestStart, requestEnd);
  const successGate = requestSource.indexOf('if (!response.success)');
  const retainedRetryBase = requestSource.lastIndexOf('lastRawText = rawText;');
  const catchStart = requestSource.indexOf('} catch (error) {');
  const catchEnd = requestSource.indexOf('} finally {', catchStart);

  assert.match(requestSource, /createCacheFingerprint\(/u);
  assert.doesNotMatch(requestSource, /JSON\.stringify\(\{ rawText/u);
  assert(successGate >= 0 && retainedRetryBase > successGate);
  assert.match(requestSource.slice(catchStart, catchEnd), /lastRawText = '';/u);
  assert.match(frameSource, /async function refineCurrentPrompt[\s\S]*?lastRawText = '';/u);
  assert.doesNotMatch(frameSource, /cachedRefinement\s*=\s*\{[^}]*rawText/u);
});

test('prominent consent names every transmitted data class and local-only metadata boundary', async () => {
  const frameHtml = await readFile(
    new URL('../extension/floating-frame.html', import.meta.url),
    'utf8'
  );
  assert.match(frameHtml, /saved refinement preferences and optional custom\s+guidance/u);
  assert.match(frameHtml, /supported AI site identifier/u);
  assert.match(frameHtml, /recent visible chat only when you enable\s+it/u);
  assert.match(
    frameHtml,
    /prompt, chat, or guidance source, a\s+request ID, and occurrence count/u
  );
  assert.match(
    frameHtml,
    /When local protection is enabled and detection\s+succeeds, detected categories, detected\s+values, and the local restoration map stay on\s+this device/u
  );
  assert.match(frameHtml, /Alpha has not read or transmitted the selected prompt text or chat/u);
  assert.match(frameHtml, /Until reset, each bubble click lets Alpha read and send/u);
  assert.match(frameHtml, /through Alpha’s gateway to\s+Google Gemini solely/u);
});

test('privacy controls disclose clipboard exposure and reset consent when protection is disabled', async () => {
  const [frameSource, popupSource, popupHtml, privacyHtml] = await Promise.all([
    readFile(new URL('../extension/floating-frame.js', import.meta.url), 'utf8'),
    readFile(new URL('../extension/popup.js', import.meta.url), 'utf8'),
    readFile(new URL('../extension/popup.html', import.meta.url), 'utf8'),
    readFile(new URL('../extension/privacy.html', import.meta.url), 'utf8')
  ]);

  assert.match(frameSource, /system clipboard, where other apps or clipboard managers may access/u);
  assert.match(popupSource, /key === 'protectSensitive' && value === false/u);
  assert.match(popupSource, /privacyConsentVersion:\s*0,[\s\S]*contextConsentVersion:\s*0/u);
  assert.match(popupSource, /storageRemove\(Object\.keys\(DEFAULTS\)\)/u);
  assert.match(popupSource, /window\.confirm\(/u);
  assert.match(popupHtml, /id="clear-local-data"/u);
  assert.match(popupHtml, /Stored locally without at-rest redaction\. Do not save secrets\./u);
  assert.match(
    privacyHtml,
    /Other applications, operating-system features, or clipboard\s+managers/u
  );
});

test('request errors stop the thinking state before the visible notice is rendered', async () => {
  const frameSource = await readFile(
    new URL('../extension/floating-frame.js', import.meta.url),
    'utf8'
  );
  const functionStart = frameSource.indexOf('async function requestEnhancement');
  const functionEnd = frameSource.indexOf('\n  async function refineCurrentPrompt', functionStart);
  assert(functionStart >= 0 && functionEnd > functionStart);
  const requestSource = frameSource.slice(functionStart, functionEnd);
  const catchStart = requestSource.indexOf('} catch (error) {');
  const finallyStart = requestSource.indexOf('} finally {', catchStart);
  assert(catchStart >= 0 && finallyStart > catchStart);
  const catchSource = requestSource.slice(catchStart, finallyStart);

  assert(catchSource.indexOf('stopThinking();') >= 0);
  assert(catchSource.indexOf('stopThinking();') < catchSource.indexOf('showNotice('));
  assert.match(requestSource.slice(finallyStart), /isThinking\) stopThinking\(\)/u);
});

test('content mutation scheduling ignores character streaming and coalesces layout bursts', async () => {
  const { AlphaContentObserver } = await loadExtensionModules(['content-observer.js'], {
    requestAnimationFrame() {},
    setTimeout() {}
  });
  const host = { contains: () => false };
  assert.equal(
    AlphaContentObserver.mutationBatchImpact(
      [{ type: 'characterData', addedNodes: [], removedNodes: [] }],
      host
    ),
    'none'
  );

  const layoutNode = { nodeType: 1, contains: () => false };
  assert.equal(
    AlphaContentObserver.mutationBatchImpact(
      [{ type: 'childList', addedNodes: [layoutNode], removedNodes: [] }],
      host
    ),
    'layout'
  );
  assert.equal(
    AlphaContentObserver.mutationBatchImpact(
      [{ type: 'childList', addedNodes: [], removedNodes: [host] }],
      host
    ),
    'host-removed'
  );

  let now = 0;
  let callbacks = 0;
  const frames = [];
  const timers = [];
  const scheduler = AlphaContentObserver.createCoalescedScheduler(
    () => {
      callbacks += 1;
    },
    {
      requestFrame(callback) {
        frames.push(callback);
        return frames.length;
      },
      setTimer(callback, delay) {
        timers.push({ callback, delay });
        return timers.length;
      },
      clearTimer() {},
      minimumIntervalMs: 500,
      now: () => now
    }
  );

  scheduler.schedule();
  scheduler.schedule();
  scheduler.schedule();
  assert.equal(frames.length, 1);
  frames.shift()();
  assert.equal(callbacks, 1);

  now = 25;
  scheduler.schedule();
  scheduler.schedule();
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 475);
  scheduler.schedule(true);
  assert.equal(frames.length, 1);
  frames.shift()();
  assert.equal(callbacks, 2);
});

function oauthConfiguration() {
  return Object.freeze({
    API_ORIGIN: 'https://api.alpha.com',
    OAUTH_AUTHORIZATION_ENDPOINT: 'https://identity.alpha.com/oauth2/authorize',
    OAUTH_TOKEN_ENDPOINT: 'https://identity.alpha.com/oauth2/token',
    OAUTH_CLIENT_ID: 'alpha-public-chrome',
    OAUTH_SCOPES: 'openid alpha.api',
    OAUTH_REDIRECT_PATH: 'alpha-oauth'
  });
}

function oauthChrome({ alterState = false, delaySessionWrite = false } = {}) {
  const local = {};
  const session = {};
  let authorizationUrl;
  let releaseSessionWrite;
  let signalSessionWrite;
  const sessionWriteStarted = new Promise((resolve) => {
    signalSessionWrite = resolve;
  });
  const redirectUri = 'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/alpha-oauth';
  const storageArea = (store, isSession = false) => ({
    get(defaults, callback) {
      callback({ ...defaults, ...store });
    },
    set(values, callback) {
      if (isSession && delaySessionWrite) {
        signalSessionWrite();
        releaseSessionWrite = () => {
          Object.assign(store, values);
          callback?.();
        };
        return;
      }
      Object.assign(store, values);
      callback?.();
    },
    remove(keys, callback) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete store[key];
      callback?.();
    }
  });
  return {
    chrome: {
      identity: {
        getRedirectURL: () => redirectUri,
        launchWebAuthFlow({ url }, callback) {
          authorizationUrl = new URL(url);
          const state = alterState ? 'wrong-state' : authorizationUrl.searchParams.get('state');
          Promise.resolve().then(() =>
            callback(`${redirectUri}?code=one-time-code&state=${state}`)
          );
        }
      },
      runtime: {},
      storage: {
        local: storageArea(local),
        session: storageArea(session, true)
      }
    },
    local,
    redirectUri,
    session,
    sessionWriteStarted,
    releaseSessionWrite: () => releaseSessionWrite?.(),
    authorizationUrl: () => authorizationUrl
  };
}

test('OAuth Authorization Code with PKCE stores only a short-lived session token', async () => {
  const chromeMock = oauthChrome();
  let tokenRequest;
  const accessToken = `alpha_${'a'.repeat(48)}`;
  const fetch = async (url, options) => {
    tokenRequest = { url, options };
    return {
      ok: true,
      headers: {
        get(name) {
          return name === 'content-type' ? 'application/json' : null;
        }
      },
      text: async () =>
        JSON.stringify({
          access_token: accessToken,
          token_type: 'Bearer',
          expires_in: 1800,
          id_token: `header.${'i'.repeat(80)}.signature`
        })
    };
  };
  const { AlphaAuth } = await loadExtensionModules(['runtime.js', 'auth.js'], {
    AlphaConfig: oauthConfiguration(),
    chrome: chromeMock.chrome,
    fetch
  });

  const result = await AlphaAuth.signIn();
  assert.equal(result.signedIn, true);
  const authorization = chromeMock.authorizationUrl();
  assert.equal(authorization.searchParams.get('response_type'), 'code');
  assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(authorization.searchParams.has('access_token'), false);
  assert.equal(authorization.searchParams.has('client_secret'), false);
  assert.equal(tokenRequest.url, oauthConfiguration().OAUTH_TOKEN_ENDPOINT);
  const exchange = new URLSearchParams(tokenRequest.options.body);
  assert.equal(exchange.get('grant_type'), 'authorization_code');
  assert.equal(exchange.get('code'), 'one-time-code');
  assert.equal(exchange.get('redirect_uri'), chromeMock.redirectUri);
  assert.ok(exchange.get('code_verifier').length >= 43);
  assert.equal(exchange.has('client_secret'), false);
  assert.equal(exchange.has('refresh_token'), false);
  assert.equal(chromeMock.session.accessToken, accessToken);
  assert.ok(chromeMock.session.accessTokenExpiresAt <= Date.now() + 1800 * 1000);
  assert.equal(Object.hasOwn(chromeMock.local, 'accessToken'), false);
  assert.equal(Object.hasOwn(chromeMock.session, 'idToken'), false);

  await AlphaAuth.signOut();
  assert.equal(Object.hasOwn(chromeMock.session, 'accessToken'), false);
});

test('OAuth rejects state mismatch and refresh or overlong token lifetimes', async () => {
  const chromeMock = oauthChrome({ alterState: true });
  let fetchCalled = false;
  const { AlphaAuth } = await loadExtensionModules(['runtime.js', 'auth.js'], {
    AlphaConfig: oauthConfiguration(),
    chrome: chromeMock.chrome,
    fetch: async () => {
      fetchCalled = true;
      throw new Error('must not exchange');
    }
  });
  await assert.rejects(AlphaAuth.signIn(), (error) => error.code === 'AUTH_STATE_MISMATCH');
  assert.equal(fetchCalled, false);
  assert.throws(
    () =>
      AlphaAuth.validatedAccessToken({
        access_token: `alpha_${'b'.repeat(48)}`,
        token_type: 'Bearer',
        expires_in: 3601
      }),
    (error) => error.code === 'AUTH_TOKEN_INVALID'
  );
  assert.throws(
    () =>
      AlphaAuth.validatedAccessToken({
        access_token: `alpha_${'c'.repeat(48)}`,
        token_type: 'Bearer',
        expires_in: 900,
        refresh_token: 'never-accepted'
      }),
    (error) => error.code === 'AUTH_TOKEN_INVALID'
  );

  let delivered = false;
  const oversizedResponse = {
    headers: { get: (name) => (name === 'content-type' ? 'application/json' : null) },
    body: {
      getReader() {
        return {
          async read() {
            if (delivered) return { done: true, value: undefined };
            delivered = true;
            return { done: false, value: new Uint8Array(65_000) };
          },
          async cancel() {}
        };
      }
    }
  };
  await assert.rejects(
    AlphaAuth.boundedTokenResponse(oversizedResponse),
    (error) => error.code === 'AUTH_TOKEN_EXCHANGE'
  );
});

test('OAuth redirect validation rejects duplicate, fragmented, and unexpected parameters', async () => {
  const chromeMock = oauthChrome();
  const { AlphaAuth } = await loadExtensionModules(['runtime.js', 'auth.js'], {
    AlphaConfig: oauthConfiguration(),
    chrome: chromeMock.chrome,
    fetch: async () => {
      throw new Error('not used');
    }
  });
  const redirect = chromeMock.redirectUri;
  const state = 'expected-state';
  for (const candidate of [
    `${redirect}?code=one&state=${state}&state=${state}`,
    `${redirect}?code=one&code=two&state=${state}`,
    `${redirect}?code=one&state=${state}&session_state=unexpected`,
    `${redirect}?code=one&state=${state}#fragment`,
    `${redirect}?error=server_error&state=${state}&error_description=${'x'.repeat(513)}`
  ]) {
    assert.throws(
      () => AlphaAuth.authorizationCodeFromRedirect(candidate, redirect, state),
      (error) => error.code === 'AUTH_INVALID_RESPONSE',
      candidate
    );
  }
});

test('sign out during a delayed session write cannot resurrect an access token', async () => {
  const chromeMock = oauthChrome({ delaySessionWrite: true });
  const accessToken = `alpha_${'d'.repeat(48)}`;
  const { AlphaAuth } = await loadExtensionModules(['runtime.js', 'auth.js'], {
    AlphaConfig: oauthConfiguration(),
    chrome: chromeMock.chrome,
    fetch: async () => ({
      ok: true,
      headers: { get: (name) => (name === 'content-type' ? 'application/json' : null) },
      text: async () =>
        JSON.stringify({ access_token: accessToken, token_type: 'Bearer', expires_in: 900 })
    })
  });

  const signIn = AlphaAuth.signIn();
  await chromeMock.sessionWriteStarted;
  await AlphaAuth.signOut();
  chromeMock.releaseSessionWrite();

  await assert.rejects(signIn, (error) => error.code === 'AUTH_CANCELLED');
  assert.equal(Object.hasOwn(chromeMock.session, 'accessToken'), false);
  const status = await AlphaAuth.status();
  assert.equal(status.signedIn, false);
  assert.equal(status.accessTokenExpiresAt, null);
});
