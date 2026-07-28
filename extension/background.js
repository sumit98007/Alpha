const DLP_RULES = [
  {
    name: 'AWS_ACCESS_KEY',
    regex: /\b(AKIA|ASCA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASIA)[A-Z0-9]{16}\b/g
  },
  {
    name: 'AWS_SECRET_KEY',
    regex: /(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{40}(?![A-Za-z0-9+/])/g
  },
  {
    name: 'OPENAI_API_KEY',
    regex: /\bsk-[a-zA-Z0-9-]{32,}\b/g
  },
  {
    name: 'STRIPE_SECRET_KEY',
    regex: /\bsk_(?:live|test)_[0-9a-zA-Z]{24,}\b/g
  },
  {
    name: 'GITHUB_PAT',
    regex: /\bghp_[0-9a-zA-Z]{36}\b|\bgithub_pat_[0-9a-zA-Z_]{82}\b/g
  },
  {
    name: 'US_SSN',
    regex: /\b\d{3}-\d{2}-\d{4}\b/g
  },
  {
    name: 'AUS_TFN',
    regex: /\b\d{3}\s*\d{3}\s*\d{3}\b/g
  },
  {
    name: 'CREDIT_CARD',
    regex: /\b(?:\d{4}[ -]?){3}\d{4}\b/g,
    validate: (val) => {
      // Luhn algorithm check
      const digits = val.replace(/[\s-]/g, '');
      let sum = 0;
      let shouldDouble = false;
      for (let i = digits.length - 1; i >= 0; i--) {
        let digit = parseInt(digits.charAt(i), 10);
        if (shouldDouble) {
          digit *= 2;
          if (digit > 9) digit -= 9;
        }
        sum += digit;
        shouldDouble = !shouldDouble;
      }
      return sum % 10 === 0;
    }
  },
  {
    name: 'DATABASE_URL',
    regex: /\b[a-zA-Z]+:\/\/[^/:]+:[^/]+@[a-zA-Z0-9.-]+:\d+\/[a-zA-Z0-9_.-]+\b/g
  }
];

// Helper to generate UUID v4
function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// Local DLP Redaction Engine
function redactSecrets(text) {
  let scrubbedText = text;
  const redactionLog = [];
  const sessionSecrets = {};
  let placeholderCount = 0;

  for (const rule of DLP_RULES) {
    rule.regex.lastIndex = 0;
    const matches = [...scrubbedText.matchAll(rule.regex)];
    const uniqueMatches = Array.from(new Set(matches.map(m => m[0])));

    for (const matchStr of uniqueMatches) {
      if (rule.validate && !rule.validate(matchStr)) {
        continue;
      }

      const placeholder = `{{ALPHA_SECRET_${placeholderCount++}}}`;
      sessionSecrets[placeholder] = matchStr;

      redactionLog.push({
        placeholder,
        type: rule.name
      });

      const escapedMatch = matchStr.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
      scrubbedText = scrubbedText.replace(new RegExp(escapedMatch, 'g'), placeholder);
    }
  }

  return { scrubbedText, redactionLog, sessionSecrets };
}

// Hydrates variables back into the optimized prompt
function hydratePrompt(optimizedText, sessionSecrets) {
  return optimizedText.replace(/\{\{\s*ALPHA_SECRET_(\d+)\s*\}\}/g, (match, id) => {
    const key = `{{ALPHA_SECRET_${id}}}`;
    return sessionSecrets[key] !== undefined ? sessionSecrets[key] : match;
  });
}

// Listener for content script and popup messaging
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'enhancePrompt') {
    const { text, platform } = message;
    
    // 1. Run local DLP check
    const { scrubbedText, redactionLog, sessionSecrets } = redactSecrets(text);
    const sessionId = generateUUID();

    // 2. Fetch the backend URL from storage
    chrome.storage.local.get({
      backendUrl: 'http://127.0.0.1:3000',
      redactedCount: 0,
      optimizedCount: 0,
      enabled: true
    }, async (settings) => {
      // If the extension is disabled, return original text
      if (!settings.enabled) {
        sendResponse({ success: true, text, cached: false });
        return;
      }

      // Check if we redacted anything
      const secretsCount = redactionLog.length;

      // 3. Make API call to Cloud Gateway
      try {
        const response = await fetch(`${settings.backendUrl}/api/enhance`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            sessionId,
            meta: {
              hostPlatform: platform,
              timestamp: Math.floor(Date.now() / 1000)
            },
            payload: {
              scrubbedText,
              redactionLog
            }
          })
        });

        if (!response.ok) {
          throw new Error(`Gateway returned HTTP ${response.status}`);
        }

        const data = await response.json();
        
        // 4. Hydrate Response Locally
        const hydratedText = hydratePrompt(data.optimizedText, sessionSecrets);

        // 5. Update Local Stats
        const newRedactedCount = settings.redactedCount + secretsCount;
        const newOptimizedCount = settings.optimizedCount + 1;
        chrome.storage.local.set({
          redactedCount: newRedactedCount,
          optimizedCount: newOptimizedCount
        });

        // 6. Return response to Content Script
        sendResponse({
          success: true,
          text: hydratedText,
          cached: data.cached || false,
          redactedThisSession: secretsCount
        });
      } catch (err) {
        console.error('Enhancement error:', err);
        sendResponse({
          success: false,
          error: `Backend Gateway error: ${err.message}`
        });
      }
    });

    // Return true to indicate asynchronous response handling
    return true;
  }
});
