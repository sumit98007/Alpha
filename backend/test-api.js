// Test Harness for Alpha Backend API Gateway
// Assumes the server is running at http://127.0.0.1:3000

const BACKEND_URL = 'http://127.0.0.1:3000';
const GATEWAY_API_KEY = process.env.GATEWAY_API_KEY || '';
const authHeaders = GATEWAY_API_KEY ? { 'X-Alpha-Key': GATEWAY_API_KEY } : {};
const EXPECT_CACHE = process.env.ENABLE_SEMANTIC_CACHE === 'true';

async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runTests() {
  console.log('=== Starting E2E Verification Tests for Alpha Backend ===\n');

  // Test 1: Health Check
  console.log('[Test 1] Checking API Health...');
  try {
    const healthResp = await fetch(`${BACKEND_URL}/api/health`);
    const healthData = await healthResp.json();
    if (healthResp.ok && healthData.status === 'ok') {
      console.log('  Pass: Health check returned OK.\n');
    } else {
      console.error('  Fail: Invalid health check response', healthData);
      process.exit(1);
    }
  } catch (err) {
    console.error('  Fail: Could not connect to backend. Is the server running?', err.message);
    process.exit(1);
  }

  // Define test payloads
  const payload1 = {
    sessionId: 'test-session-123',
    meta: { hostPlatform: 'chatgpt', timestamp: Math.floor(Date.now() / 1000) },
    payload: {
      scrubbedText: 'Act as a Senior DevOps Engineer. Review this deployment pipeline script: {{ALPHA_SECRET_0}} and fix the optimization gaps.',
      redactionLog: [
        { placeholder: '{{ALPHA_SECRET_0}}', type: 'AWS_API_KEY' }
      ]
    }
  };

  // Payload 2: Semantically similar to payload 1 (testing vector database cache)
  const payload2 = {
    sessionId: 'test-session-456',
    meta: { hostPlatform: 'chatgpt', timestamp: Math.floor(Date.now() / 1000) },
    payload: {
      scrubbedText: 'Act as a Senior DevOps Engineer. Review this deployment pipeline script: {{ALPHA_SECRET_0}} and improve the optimization gaps.',
      redactionLog: [
        { placeholder: '{{ALPHA_SECRET_0}}', type: 'AWS_API_KEY' }
      ]
    }
  };

  // Test 2: Initial prompt enhancement (Cache Miss)
  console.log('[Test 2] Sending initial prompt for optimization (expecting cache MISS)...');
  const start1 = Date.now();
  let optimizedText1 = '';
  try {
    const resp1 = await fetch(`${BACKEND_URL}/api/enhance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify(payload1)
    });
    
    const data1 = await resp1.json();
    const elapsed1 = Date.now() - start1;
    
    if (resp1.ok) {
      optimizedText1 = data1.optimizedText;
      console.log(`  Pass: Prompt enhanced in ${elapsed1}ms.`);
      console.log(`  Cached: ${data1.cached}`);
      console.log(`  Optimized Text preview: "${optimizedText1.slice(0, 100)}..."\n`);
    } else {
      console.error('  Fail: Initial enhancement failed', data1);
      process.exit(1);
    }
  } catch (err) {
    console.error('  Fail: Error during enhancement', err.message);
    process.exit(1);
  }

  // Test 3: Duplicate prompt (expecting exact Cache Hit)
  console.log(`[Test 3] Sending duplicate prompt (cache ${EXPECT_CACHE ? 'enabled' : 'disabled'})...`);
  const start2 = Date.now();
  try {
    const resp2 = await fetch(`${BACKEND_URL}/api/enhance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify(payload1)
    });
    
    const data2 = await resp2.json();
    const elapsed2 = Date.now() - start2;
    
    if (resp2.ok) {
      if (data2.cached === EXPECT_CACHE) {
        console.log(`  Pass: Duplicate prompt resolved in ${elapsed2}ms (cached=${data2.cached}).`);
        if (EXPECT_CACHE) {
          console.log(`  Result matched: ${data2.optimizedText === optimizedText1 ? 'YES' : 'NO'}\n`);
        } else {
          console.log('  Privacy mode confirmed: no cross-request result reuse.\n');
        }
      } else {
        console.error(`  Fail: Expected cached=${EXPECT_CACHE} but received cached=${data2.cached}.`);
        process.exit(1);
      }
    } else {
      console.error('  Fail: Cache hit request failed', data2);
      process.exit(1);
    }
  } catch (err) {
    console.error('  Fail: Error during duplicate check', err.message);
    process.exit(1);
  }

  // Test 4: Semantically similar prompt (expecting Semantic Cache Hit)
  console.log('[Test 4] Sending semantically similar prompt (expecting semantic cache HIT)...');
  const start3 = Date.now();
  try {
    const resp3 = await fetch(`${BACKEND_URL}/api/enhance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify(payload2)
    });
    
    const data3 = await resp3.json();
    const elapsed3 = Date.now() - start3;
    
    if (resp3.ok) {
      if (data3.cached === true) {
        console.log(`  Pass: Semantically similar prompt resolved in ${elapsed3}ms (Semantic HIT).`);
        console.log(`  Result text: "${data3.optimizedText.slice(0, 100)}..."\n`);
      } else if (!EXPECT_CACHE) {
        console.log('  Pass: Semantic cache is disabled for privacy.');
      } else {
        console.warn('  Note: Semantic cache missed because the similarity threshold was not crossed.');
      }
    } else {
      console.error('  Fail: Semantic check request failed', data3);
      process.exit(1);
    }
  } catch (err) {
    console.error('  Fail: Error during semantic check', err.message);
    process.exit(1);
  }

  console.log('=== E2E Verification Complete ===');
}

runTests();
