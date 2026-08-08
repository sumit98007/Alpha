document.addEventListener('DOMContentLoaded', () => {
  const controls = {
    enabled: document.getElementById('toggle-active'),
    taskField: document.getElementById('task-field'),
    enhancementMode: document.getElementById('prompt-detail'),
    protectSensitive: document.getElementById('protect-sensitive'),
    preserveVoice: document.getElementById('preserve-voice'),
    askClarifying: document.getElementById('ask-clarifying'),
    qualityChecks: document.getElementById('quality-checks'),
    useChatContext: document.getElementById('use-chat-context'),
    customGuidance: document.getElementById('custom-guidance'),
  };
  const statusDot = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');
  const saveStatus = document.getElementById('save-status');

  const defaults = {
    enabled: true,
    taskField: 'auto',
    enhancementMode: 'balanced',
    protectSensitive: true,
    preserveVoice: true,
    askClarifying: true,
    qualityChecks: true,
    useChatContext: false,
    customGuidance: '',
    redactedCount: 0,
    optimizedCount: 0,
    backendUrl: 'http://127.0.0.1:3000',
    gatewayApiKey: '',
  };

  chrome.storage.local.get(defaults, (settings) => {
    for (const [key, element] of Object.entries(controls)) {
      if (element.type === 'checkbox') element.checked = settings[key];
      else element.value = settings[key];
    }
    document.getElementById('stat-redacted').textContent = settings.redactedCount;
    document.getElementById('stat-optimized').textContent = settings.optimizedCount;
    checkBackendConnection(settings.backendUrl, settings.gatewayApiKey);
  });

  for (const [key, element] of Object.entries(controls)) {
    if (key === 'customGuidance') continue;
    element.addEventListener('change', () => {
      chrome.storage.local.set({ [key]: element.type === 'checkbox' ? element.checked : element.value });
    });
  }

  document.getElementById('save-guidance').addEventListener('click', () => {
    chrome.storage.local.set({ customGuidance: controls.customGuidance.value.trim() }, () => {
      saveStatus.classList.add('show');
      setTimeout(() => saveStatus.classList.remove('show'), 1600);
    });
  });

  async function checkBackendConnection(url, apiKey) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1800);
      const response = await fetch(`${url}/api/ready`, {
        signal: controller.signal,
        headers: apiKey ? { 'X-Alpha-Key': apiKey } : {}
      });
      clearTimeout(timeout);
      if (!response.ok) throw new Error('Gateway unavailable');
      const data = await response.json();
      if (data.status !== 'ready') throw new Error('Gateway unavailable');
      statusDot.classList.add('online');
      statusText.textContent = 'Alpha ready';
    } catch (error) {
      statusDot.classList.remove('online');
      statusText.textContent = 'Alpha unavailable';
    }
  }
});
