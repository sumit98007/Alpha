document.addEventListener('DOMContentLoaded', () => {
  const urlInput = document.getElementById('backend-url');
  const btnSave = document.getElementById('btn-save');
  const btnTest = document.getElementById('btn-test');
  const statusBox = document.getElementById('status-box');

  // Load existing settings
  chrome.storage.local.get({ backendUrl: 'http://127.0.0.1:3000' }, (result) => {
    urlInput.value = result.backendUrl;
  });

  function showStatus(message, isError = false) {
    statusBox.textContent = message;
    statusBox.className = 'status ' + (isError ? 'error' : 'success');
    setTimeout(() => {
      statusBox.style.display = 'none';
    }, 4000);
  }

  // Save settings
  btnSave.addEventListener('click', () => {
    let url = urlInput.value.trim();
    if (!url) {
      showStatus('URL cannot be empty.', true);
      return;
    }

    // Strip trailing slash for consistency
    if (url.endsWith('/')) {
      url = url.slice(0, -1);
    }

    chrome.storage.local.set({ backendUrl: url }, () => {
      showStatus('Settings saved successfully.');
    });
  });

  // Test connection
  btnTest.addEventListener('click', async () => {
    let url = urlInput.value.trim();
    if (!url) {
      showStatus('URL cannot be empty.', true);
      return;
    }
    
    if (url.endsWith('/')) {
      url = url.slice(0, -1);
    }

    showStatus('Testing connection...');

    try {
      const response = await fetch(`${url}/api/health`, {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
      });

      if (!response.ok) {
        throw new Error(`HTTP error ${response.status}`);
      }

      const data = await response.json();
      if (data && data.status === 'ok') {
        showStatus('Connection successful! Backend is online.');
      } else {
        showStatus('Received invalid response from backend.', true);
      }
    } catch (err) {
      showStatus(`Connection failed: Make sure backend is running at ${url}`, true);
    }
  });
});
