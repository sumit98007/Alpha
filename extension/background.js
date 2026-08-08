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
function redactSecrets(text, placeholderPrefix = 'ALPHA_SECRET') {
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

      const placeholder = `{{${placeholderPrefix}_${placeholderCount++}}}`;
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

function estimateTokens(text) {
  return Math.max(1, Math.ceil(text.length / 4));
}

function gatewayHeaders(apiKey) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['X-Alpha-Key'] = apiKey;
  return headers;
}

// Listener for content script and popup messaging
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'createChatEnvironment') {
    const purpose = typeof message.purpose === 'string' ? message.purpose.trim() : '';
    const platform = message.platform || 'generic';
    if (!purpose) {
      sendResponse({ success: false, error: 'Describe what this chat is for.' });
      return false;
    }

    const { scrubbedText: scrubbedPurpose, redactionLog } = redactSecrets(purpose);
    const sessionId = generateUUID();

    chrome.storage.local.get({
      backendUrl: 'http://127.0.0.1:3000',
      gatewayApiKey: '',
      chatEnvironments: {},
      redactedCount: 0
    }, async (settings) => {
      try {
        const response = await fetch(`${settings.backendUrl}/api/environment`, {
          method: 'POST',
          headers: gatewayHeaders(settings.gatewayApiKey),
          body: JSON.stringify({
            sessionId,
            meta: { hostPlatform: platform },
            payload: { scrubbedPurpose }
          })
        });
        if (!response.ok) throw new Error(`Gateway returned HTTP ${response.status}`);

        const data = await response.json();
        const chatEnvironments = {
          ...settings.chatEnvironments,
          [platform]: {
            purpose,
            environmentText: data.environmentText,
            updatedAt: Date.now()
          }
        };
        await chrome.storage.local.set({
          chatEnvironments,
          redactedCount: settings.redactedCount + redactionLog.length
        });
        sendResponse({ success: true, environment: chatEnvironments[platform] });
      } catch (err) {
        sendResponse({ success: false, error: `Backend Gateway error: ${err.message}` });
      }
    });
    return true;
  }

  if (message.action === 'enhancePrompt') {
    const { text, platform, preferences = {}, conversationContext = '' } = message;
    const sessionId = generateUUID();

    // 2. Fetch the backend URL from storage
    chrome.storage.local.get({
      backendUrl: 'http://127.0.0.1:3000',
      gatewayApiKey: '',
      redactedCount: 0,
      optimizedCount: 0,
      enabled: true,
      enhancementMode: 'balanced',
      taskField: 'auto',
      protectSensitive: true,
      preserveVoice: true,
      askClarifying: true,
      qualityChecks: true,
      useChatContext: false,
      customGuidance: '',
      chatEnvironments: {}
    }, async (settings) => {
      // If the extension is disabled, return original text
      if (!settings.enabled) {
        sendResponse({ success: true, text, cached: false });
        return;
      }

      // Run local protection only when the user has enabled it.
      const protection = settings.protectSensitive
        ? redactSecrets(text)
        : { scrubbedText: text, redactionLog: [], sessionSecrets: {} };
      const { scrubbedText, redactionLog, sessionSecrets } = protection;
      const contextProtection = settings.useChatContext && typeof conversationContext === 'string'
        ? redactSecrets(conversationContext.slice(-12000), 'ALPHA_CONTEXT_SECRET')
        : { scrubbedText: '', redactionLog: [] };
      const scrubbedConversationContext = contextProtection.scrubbedText;
      const secretsCount = redactionLog.length + contextProtection.redactionLog.length;
      const savedEnvironment = settings.chatEnvironments[platform]?.environmentText || '';
      const customGuidance = typeof settings.customGuidance === 'string'
        ? settings.customGuidance.trim()
        : '';
      const scrubbedGuidance = settings.protectSensitive && customGuidance
        ? redactSecrets(customGuidance).scrubbedText
        : customGuidance;
      const chatEnvironment = [savedEnvironment, scrubbedGuidance]
        .filter(Boolean)
        .join('\n\nAdditional user guidance:\n');

      // 3. Make API call to Cloud Gateway
      try {
        const response = await fetch(`${settings.backendUrl}/api/enhance`, {
          method: 'POST',
          headers: gatewayHeaders(settings.gatewayApiKey),
          body: JSON.stringify({
            sessionId,
            meta: {
              hostPlatform: platform,
              timestamp: Math.floor(Date.now() / 1000)
            },
            payload: {
              scrubbedText,
              redactionLog
            },
            preferences: {
              mode: preferences.mode || settings.enhancementMode || 'balanced',
              taskType: preferences.taskType || settings.taskField || 'auto',
              chatEnvironment,
              preserveVoice: settings.preserveVoice,
              askClarifying: settings.askClarifying,
              qualityChecks: settings.qualityChecks,
              conversationContext: scrubbedConversationContext
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
          redactedThisSession: secretsCount,
          mode: data.mode || preferences.mode || settings.enhancementMode || 'balanced',
          taskType: data.taskType || preferences.taskType || settings.taskField || 'auto',
          estimatedTokens: data.estimatedTokens || estimateTokens(hydratedText),
          originalEstimatedTokens: estimateTokens(text),
          degraded: data.degraded === true,
          contextUsed: Boolean(scrubbedConversationContext)
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
