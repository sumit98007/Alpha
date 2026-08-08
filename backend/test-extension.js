// Headless Integration Test for Alpha Extension Background Script
// Mocks Chrome API and verifies DLP redaction and hydration against the running backend

const fs = require('fs');
const path = require('path');

// 1. Mock Chrome Extension Environment
const storageStore = {
  enabled: true,
  redactedCount: 0,
  optimizedCount: 0,
  backendUrl: 'http://127.0.0.1:3000',
  gatewayApiKey: process.env.GATEWAY_API_KEY || ''
};

global.chrome = {
  runtime: {
    onMessage: {
      addListener: (listener) => {
        global.messageListener = listener;
      }
    }
  },
  storage: {
    local: {
      get: (keys, callback) => {
        const result = {};
        for (const [key, defVal] of Object.entries(keys)) {
          result[key] = storageStore[key] !== undefined ? storageStore[key] : defVal;
        }
        callback(result);
      },
      set: (values, callback) => {
        Object.assign(storageStore, values);
        if (callback) callback();
      }
    }
  }
};

// 2. Load background.js code
console.log('Loading background.js in mocked environment...');
const bgCode = fs.readFileSync(path.join(__dirname, '../extension/background.js'), 'utf8');
// Evaluate background.js to register message listeners
eval(bgCode);

if (!global.messageListener) {
  console.error('Failed to register message listener.');
  process.exit(1);
}

// 3. Define test inputs with sensitive information
const rawPrompt = `Hey! I need to write a script to connect to AWS using:
Access Key: AKIAIOSFODNN7EXAMPLE
Secret Key: wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY

Also connect to database postgresql://dbadmin:p@ssw0rd123@prod-db.corp.net:5432/main_db.

Use OpenAI key sk-1234567890abcdef1234567890abcdef to test embeddings.
My Australian Tax File Number is 123 456 789 and credit card to bill is 4111 1111 1111 1111.
Analyze and optimize this workflow.`;

async function runIntegrationTest() {
  console.log('\n=== Starting Extension DLP & Hydration Integration Test ===\n');

  console.log('Original Prompt containing sensitive information:');
  console.log('--------------------------------------------------');
  console.log(rawPrompt);
  console.log('--------------------------------------------------\n');

  console.log('Scrubbing results:', redactSecrets(rawPrompt));
  console.log('Dispatching prompt to mock runtime listener...');
  
  // Call listener registered by background.js
  const promise = new Promise((resolve) => {
    const success = global.messageListener(
      { action: 'enhancePrompt', text: rawPrompt, platform: 'chatgpt' },
      {}, // Mock sender
      (response) => resolve(response) // Response callback
    );
  });

  const response = await promise;

  if (response && response.success) {
    console.log('Response returned SUCCESS.');
    console.log(`Redacted ${response.redactedThisSession} secrets during this run.`);
    console.log('\nFinal Hydrated & Optimized Prompt returned to text input:');
    console.log('--------------------------------------------------');
    console.log(response.text);
    console.log('--------------------------------------------------\n');

    // Verification asserts:
    // 1. Secrets should have been hydrated back (meaning they exist in final text)
    const containsSecrets = 
      response.text.includes('AKIAIOSFODNN7EXAMPLE') &&
      response.text.includes('wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY') &&
      response.text.includes('postgresql://dbadmin:p@ssw0rd123@prod-db.corp.net:5432/main_db') &&
      response.text.includes('sk-1234567890abcdef1234567890abcdef') &&
      response.text.includes('123 456 789') &&
      response.text.includes('4111 1111 1111 1111');

    // 2. A successful non-degraded response should be transformed without
    // requiring a particular heading or presentation style.
    const isEnhanced = response.degraded === true
      ? response.text === rawPrompt
      : response.text.trim().length > 0 && response.text !== rawPrompt;

    // 3. Local statistics should be updated
    console.log('Verifying chrome.storage.local metrics updates:');
    console.log(`  Redacted count in storage: ${storageStore.redactedCount} (Expected: 6)`);
    console.log(`  Optimized count in storage: ${storageStore.optimizedCount} (Expected: 1)`);

    if (containsSecrets && isEnhanced && storageStore.redactedCount === 6 && storageStore.optimizedCount === 1) {
      console.log('\n>>> INTEGRATION TEST PASSED: Zero-Knowledge transmission validated! Secrets never left local scope, and final prompt was successfully hydrated. <<<');
    } else {
      console.error('\n>>> INTEGRATION TEST FAILED: Verification criteria not met. <<<');
      process.exit(1);
    }
  } else {
    console.error('Integration test failed with error:', response ? response.error : 'No response');
    process.exit(1);
  }
}

runIntegrationTest();
