const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const storage = {
  backendUrl: 'http://127.0.0.1:3000',
  enabled: true,
  enhancementMode: 'balanced',
  chatEnvironments: {},
  redactedCount: 0,
  optimizedCount: 0,
};
let listener;
let enhanceRequest;

global.chrome = {
  runtime: {
    onMessage: {
      addListener(callback) {
        listener = callback;
      },
    },
  },
  storage: {
    local: {
      get(defaults, callback) {
        callback({ ...defaults, ...storage });
      },
      set(values, callback) {
        Object.assign(storage, values);
        if (callback) callback();
      },
    },
  },
};

global.fetch = async (url, options) => {
  const body = JSON.parse(options.body);
  if (url.endsWith('/api/environment')) {
    assert.equal(body.payload.scrubbedPurpose, 'Prepare me for product interviews.');
    return {
      ok: true,
      json: async () => ({
        environmentText: 'Purpose: Prepare the user for product interviews.',
      }),
    };
  }

  if (url.endsWith('/api/enhance')) {
    enhanceRequest = body;
    return {
      ok: true,
      json: async () => ({
        optimizedText: 'Give me a structured mock product interview.',
        estimatedTokens: 11,
      }),
    };
  }

  throw new Error(`Unexpected URL: ${url}`);
};

const backgroundPath = path.join(__dirname, '../extension/background.js');
eval(fs.readFileSync(backgroundPath, 'utf8'));

const contentSource = fs.readFileSync(path.join(__dirname, '../extension/content.js'), 'utf8');
assert.match(contentSource, /data-state|dataset\.state/);
assert.match(contentSource, /ResizeObserver/);
assert.match(contentSource, /panel\.classList\.add\('detached'\)/);
assert.match(contentSource, /host\._alphaReposition/);
assert.match(contentSource, /floatingPosition/);
assert.match(contentSource, /launcher\.classList\.add\('dragging'\)/);
assert.match(contentSource, /id="alpha-retry"/);
assert.match(contentSource, /fitPanelToViewport/);
assert.match(contentSource, /panelMaxHeight/);
assert.match(contentSource, /cachedRefinement/);
assert.match(contentSource, /forceRefresh/);
assert.match(contentSource, /requestEnhancement\(lastRawText, true\)/);
assert.match(contentSource, /collectConversationContext/);
assert.match(contentSource, /slice\(-8\)/);

const geminiSource = fs.readFileSync(path.join(__dirname, 'src/gemini.ts'), 'utf8');
assert.match(geminiSource, /minimum sufficient prompt/);
assert.match(geminiSource, /If the input is already strong/);
assert.match(geminiSource, /Never output, reproduce, or refer to an \{\{ALPHA_CONTEXT_SECRET_X\}\}/);

function send(message) {
  return new Promise((resolve) => listener(message, {}, resolve));
}

async function run() {
  const automaticResponse = await send({
    action: 'enhancePrompt',
    platform: 'chatgpt',
    text: 'Review this API handler for security problems.',
    preferences: { mode: 'balanced', taskType: 'auto' },
  });

  assert.equal(automaticResponse.success, true);
  assert.equal(enhanceRequest.preferences.taskType, 'auto');
  assert.equal(enhanceRequest.preferences.chatEnvironment, '');
  assert.equal(enhanceRequest.preferences.preserveVoice, true);
  assert.equal(enhanceRequest.preferences.askClarifying, true);
  assert.equal(enhanceRequest.preferences.qualityChecks, true);

  const environmentResponse = await send({
    action: 'createChatEnvironment',
    platform: 'chatgpt',
    purpose: 'Prepare me for product interviews.',
  });

  assert.equal(environmentResponse.success, true);
  assert.equal(storage.chatEnvironments.chatgpt.purpose, 'Prepare me for product interviews.');

  const enhancementResponse = await send({
    action: 'enhancePrompt',
    platform: 'chatgpt',
    text: 'interview me',
    preferences: { mode: 'balanced' },
  });

  assert.equal(enhancementResponse.success, true);
  assert.equal(
    enhanceRequest.preferences.chatEnvironment,
    'Purpose: Prepare the user for product interviews.'
  );
  console.log('Automatic and optional environment flows passed.');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
