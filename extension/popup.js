document.addEventListener('DOMContentLoaded', async () => {
  'use strict';

  const { CONSENT_VERSION, DEFAULTS, sendMessage, storageGet, storageRemove, storageSet } =
    globalThis.AlphaRuntime;
  const controls = {
    enabled: document.getElementById('toggle-active'),
    taskField: document.getElementById('task-field'),
    enhancementMode: document.getElementById('prompt-detail'),
    protectSensitive: document.getElementById('protect-sensitive'),
    preserveVoice: document.getElementById('preserve-voice'),
    askClarifying: document.getElementById('ask-clarifying'),
    qualityChecks: document.getElementById('quality-checks'),
    useChatContext: document.getElementById('use-chat-context'),
    customGuidance: document.getElementById('custom-guidance')
  };
  const statusDot = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');
  const saveStatus = document.getElementById('save-status');
  const contextDetail = document.getElementById('context-detail');
  const privacyStatus = document.getElementById('privacy-status');
  const authCopy = document.getElementById('auth-copy');
  const signInButton = document.getElementById('sign-in');
  const signOutButton = document.getElementById('sign-out');

  function showSaveStatus(message = 'Saved') {
    saveStatus.textContent = message;
    saveStatus.classList.add('show');
    setTimeout(() => saveStatus.classList.remove('show'), 1600);
  }

  function renderPrivacyStatus(settings) {
    privacyStatus.textContent =
      settings.privacyConsentVersion === CONSENT_VERSION
        ? 'Prompt processing allowed. You can reset this choice below.'
        : 'Alpha will ask before it first reads or transmits your prompt.';
    contextDetail.textContent =
      settings.contextConsentVersion === CONSENT_VERSION
        ? 'Include up to 8 recent messages after your selected local protection'
        : 'You’ll confirm before Alpha first reads or includes recent messages';
  }

  function renderAuthentication(auth) {
    const signedIn = auth?.signedIn === true;
    signInButton.hidden = signedIn;
    signOutButton.hidden = !signedIn;
    signInButton.disabled = false;
    signOutButton.disabled = false;
    authCopy.textContent = signedIn
      ? 'Signed in securely for this browser session. Alpha does not store a refresh token.'
      : 'Sign in to refine prompts. Your short-lived access token stays in browser-session memory only.';
    if (!signedIn) {
      statusDot.classList.remove('online');
      statusText.textContent = 'Sign in required';
    }
  }

  async function checkService() {
    statusText.textContent = 'Checking Alpha';
    try {
      const response = await sendMessage({ action: 'checkService' });
      if (!response?.success) {
        if (response?.code === 'AUTH_REQUIRED' || response?.code === 'AUTH_EXPIRED') {
          renderAuthentication({ signedIn: false });
          authCopy.textContent = response.error;
          return;
        }
        throw new Error(response?.error || 'Service unavailable');
      }
      statusDot.classList.add('online');
      statusText.textContent = 'Alpha ready';
    } catch (_error) {
      statusDot.classList.remove('online');
      statusText.textContent = 'Alpha unavailable';
    }
  }

  try {
    const settings = await storageGet(DEFAULTS);
    for (const [key, element] of Object.entries(controls)) {
      if (element.type === 'checkbox') element.checked = Boolean(settings[key]);
      else element.value = settings[key];
    }
    document.getElementById('stat-redacted').textContent = settings.redactedCount;
    document.getElementById('stat-optimized').textContent = settings.optimizedCount;
    renderPrivacyStatus(settings);
  } catch (_error) {
    statusText.textContent = 'Refresh Alpha';
  }

  for (const [key, element] of Object.entries(controls)) {
    if (key === 'customGuidance') continue;
    element.addEventListener('change', async () => {
      try {
        const value = element.type === 'checkbox' ? element.checked : element.value;
        const changes = { [key]: value };
        if (key === 'protectSensitive' && value === false) {
          Object.assign(changes, {
            privacyConsentVersion: 0,
            privacyConsentAt: null,
            contextConsentVersion: 0,
            contextConsentAt: null
          });
        }
        await storageSet(changes);
        if (key === 'useChatContext' || key === 'protectSensitive') {
          renderPrivacyStatus(await storageGet(DEFAULTS));
        }
        if (key === 'protectSensitive' && value === false) {
          showSaveStatus('Consent reset');
        }
      } catch (_error) {
        showSaveStatus('Could not save');
      }
    });
  }

  document.getElementById('save-guidance').addEventListener('click', async () => {
    try {
      await storageSet({ customGuidance: controls.customGuidance.value.trim() });
      showSaveStatus();
    } catch (_error) {
      showSaveStatus('Could not save');
    }
  });

  document.getElementById('open-privacy').addEventListener('click', async () => {
    try {
      const response = await sendMessage({ action: 'openPrivacyNotice' });
      if (!response?.success) throw new Error(response?.error);
      window.close();
    } catch (_error) {
      showSaveStatus('Could not open');
    }
  });

  document.getElementById('reset-consent').addEventListener('click', async () => {
    try {
      await storageSet({
        privacyConsentVersion: 0,
        privacyConsentAt: null,
        contextConsentVersion: 0,
        contextConsentAt: null,
        useChatContext: false
      });
      controls.useChatContext.checked = false;
      renderPrivacyStatus(await storageGet(DEFAULTS));
      showSaveStatus('Choices reset');
    } catch (_error) {
      showSaveStatus('Could not reset');
    }
  });

  document.getElementById('clear-local-data').addEventListener('click', async () => {
    // The browser-owned confirmation prevents accidental deletion of persistent user preferences.
    // eslint-disable-next-line no-alert
    const confirmed = window.confirm(
      'Clear Alpha preferences, consent choices, custom guidance, position, and local counters?'
    );
    if (!confirmed) return;
    try {
      await storageRemove(Object.keys(DEFAULTS));
      for (const [key, element] of Object.entries(controls)) {
        if (element.type === 'checkbox') element.checked = Boolean(DEFAULTS[key]);
        else element.value = DEFAULTS[key];
      }
      document.getElementById('stat-redacted').textContent = '0';
      document.getElementById('stat-optimized').textContent = '0';
      renderPrivacyStatus(DEFAULTS);
      showSaveStatus('Saved data cleared');
    } catch (_error) {
      showSaveStatus('Could not clear');
    }
  });

  signInButton.addEventListener('click', async () => {
    signInButton.disabled = true;
    authCopy.textContent = 'Opening secure sign in…';
    try {
      const response = await sendMessage({ action: 'startSignIn' });
      if (!response?.signedIn) throw new Error(response?.error || 'Sign in did not complete.');
      renderAuthentication(response);
      await checkService();
    } catch (error) {
      renderAuthentication({ signedIn: false });
      authCopy.textContent = error.message || 'Sign in did not complete. Please try again.';
    }
  });

  signOutButton.addEventListener('click', async () => {
    signOutButton.disabled = true;
    try {
      const response = await sendMessage({ action: 'signOut' });
      if (response?.success === false) throw new Error(response.error);
      renderAuthentication({ signedIn: false });
    } catch (error) {
      signOutButton.disabled = false;
      authCopy.textContent = error.message || 'Alpha could not sign out. Please try again.';
    }
  });

  try {
    const auth = await sendMessage({ action: 'getAuthStatus' });
    if (auth?.success === false) throw new Error(auth.error);
    renderAuthentication(auth);
    if (auth?.signedIn) await checkService();
  } catch (_error) {
    renderAuthentication({ signedIn: false });
    authCopy.textContent = 'Alpha could not check your sign-in status. Refresh and try again.';
  }
});
