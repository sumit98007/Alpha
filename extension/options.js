document.addEventListener('DOMContentLoaded', () => {
  const urlInput = document.getElementById('backend-url');
  const apiKeyInput = document.getElementById('gateway-api-key');
  const btnSave = document.getElementById('btn-save');
  const btnTest = document.getElementById('btn-test');
  const statusBox = document.getElementById('status-box');

  // Load existing settings
  chrome.storage.local.get({ backendUrl: 'http://127.0.0.1:3000', gatewayApiKey: '' }, (result) => {
    urlInput.value = result.backendUrl;
    apiKeyInput.value = result.gatewayApiKey;
  });

  function showStatus(message, isError = false) {
    statusBox.textContent = message;
    statusBox.className = 'status ' + (isError ? 'error' : 'success');
    setTimeout(() => {
      statusBox.style.display = 'none';
    }, 4000);
  }

  function normalizeGatewayUrl(value) {
    const parsed = new URL(value);
    const isLocalhost = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';
    if (parsed.protocol !== 'https:' && !(isLocalhost && parsed.protocol === 'http:')) {
      throw new Error('Use HTTPS for production gateways. HTTP is allowed only for localhost.');
    }
    return parsed.origin;
  }

  async function ensureGatewayPermission(url) {
    const originPattern = `${new URL(url).origin}/*`;
    const hasPermission = await chrome.permissions.contains({ origins: [originPattern] });
    if (hasPermission) return true;
    return chrome.permissions.request({ origins: [originPattern] });
  }

  // Save settings
  btnSave.addEventListener('click', async () => {
    if (!urlInput.value.trim()) {
      showStatus('URL cannot be empty.', true);
      return;
    }

    try {
      const url = normalizeGatewayUrl(urlInput.value.trim());
      const granted = await ensureGatewayPermission(url);
      if (!granted) {
        showStatus('Gateway access was not granted.', true);
        return;
      }
      await chrome.storage.local.set({
        backendUrl: url,
        gatewayApiKey: apiKeyInput.value.trim()
      });
      urlInput.value = url;
      showStatus('Settings saved successfully.');
    } catch (err) {
      showStatus(err.message || 'Enter a valid gateway URL.', true);
    }
  });

  // Test connection
  btnTest.addEventListener('click', async () => {
    if (!urlInput.value.trim()) {
      showStatus('URL cannot be empty.', true);
      return;
    }

    showStatus('Testing connection...');

    try {
      const url = normalizeGatewayUrl(urlInput.value.trim());
      const granted = await ensureGatewayPermission(url);
      if (!granted) {
        showStatus('Gateway access was not granted.', true);
        return;
      }
      const apiKey = apiKeyInput.value.trim();
      const response = await fetch(`${url}/api/ready`, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          ...(apiKey ? { 'X-Alpha-Key': apiKey } : {})
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP error ${response.status}`);
      }

      const data = await response.json();
      if (data && data.status === 'ready') {
        showStatus('Connection successful! Backend is online.');
      } else {
        showStatus('Received invalid response from backend.', true);
      }
    } catch (err) {
      showStatus(`Connection failed: ${err.message || 'gateway unavailable'}`, true);
    }
  });
});
