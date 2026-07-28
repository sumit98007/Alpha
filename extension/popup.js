document.addEventListener('DOMContentLoaded', () => {
  const toggleActive = document.getElementById('toggle-active');
  const statusDot = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');
  const statRedacted = document.getElementById('stat-redacted');
  const statOptimized = document.getElementById('stat-optimized');
  const btnSettings = document.getElementById('btn-settings');
  const btnReset = document.getElementById('btn-reset');
  const btnHome = document.getElementById('btn-home');

  // Helper to format values as double digits (e.g. 05 instead of 5)
  function formatDoubleDigit(value) {
    const num = parseInt(value, 10) || 0;
    return num < 10 ? `0${num}` : num;
  }

  // 1. Load initial states from local storage
  chrome.storage.local.get({
    enabled: true,
    redactedCount: 0,
    optimizedCount: 0,
    backendUrl: 'http://127.0.0.1:3000'
  }, (settings) => {
    toggleActive.checked = settings.enabled;
    statRedacted.textContent = formatDoubleDigit(settings.redactedCount);
    statOptimized.textContent = formatDoubleDigit(settings.optimizedCount);
    
    // Check backend connection status
    checkBackendConnection(settings.backendUrl);
  });

  // 2. Bind change event on the active toggle
  toggleActive.addEventListener('change', () => {
    const isEnabled = toggleActive.checked;
    chrome.storage.local.set({ enabled: isEnabled });
  });

  // 3. Open settings page when clicking settings button in dock
  btnSettings.addEventListener('click', () => {
    // Visual click feedback
    btnSettings.classList.add('active');
    btnHome.classList.remove('active');
    
    if (chrome.runtime.openOptionsPage) {
      chrome.runtime.openOptionsPage();
    } else {
      window.open(chrome.runtime.getURL('options.html'));
    }
  });

  // 4. Reset counters when clicking reset button in dock
  btnReset.addEventListener('click', () => {
    if (confirm('Are you sure you want to reset your enhancement and redaction statistics?')) {
      chrome.storage.local.set({
        redactedCount: 0,
        optimizedCount: 0
      }, () => {
        statRedacted.textContent = '00';
        statOptimized.textContent = '00';
        
        // Show temporary visual feedback
        btnReset.style.color = '#ef4444';
        setTimeout(() => {
          btnReset.style.color = '';
        }, 1000);
      });
    }
  });

  // Function to ping the backend health endpoint
  async function checkBackendConnection(url) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 1500); // 1.5s timeout

      const response = await fetch(`${url}/api/health`, {
        method: 'GET',
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      if (response.ok) {
        const data = await response.json();
        if (data && data.status === 'ok') {
          statusDot.className = 'status-dot online';
          statusText.textContent = 'Active';
          statusText.style.color = '#10b981';
          return;
        }
      }
      throw new Error('Connection response invalid.');
    } catch (err) {
      statusDot.className = 'status-dot';
      statusText.textContent = 'Offline';
      statusText.style.color = 'rgba(255, 255, 255, 0.45)';
    }
  }
});
