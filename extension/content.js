function getPlatform() {
  const host = window.location.hostname;
  if (host.includes('chatgpt.com')) return 'chatgpt';
  if (host.includes('claude.ai')) return 'claude';
  if (host.includes('gemini.google.com')) return 'gemini';
  return 'generic';
}

function findInputElement() {
  const platform = getPlatform();
  if (platform === 'chatgpt') {
    return document.querySelector('#prompt-textarea');
  } else if (platform === 'claude') {
    return document.querySelector('div[contenteditable="true"].ProseMirror') || 
           document.querySelector('div[contenteditable="true"]');
  } else if (platform === 'gemini') {
    return document.querySelector('div[contenteditable="true"].ql-editor') ||
           document.querySelector('rich-textarea div[contenteditable="true"]') ||
           document.querySelector('div[contenteditable="true"]');
  }
  
  // Generic fallback
  return document.querySelector('textarea') || document.querySelector('div[contenteditable="true"]');
}

function setInputValue(element, value) {
  if (element.tagName === 'TEXTAREA' || element.tagName === 'INPUT') {
    element.value = value;
    // Trigger React/Vue state bindings
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  } else if (element.getAttribute('contenteditable') === 'true') {
    element.focus();
    
    // Utilize execCommand('insertText') for robust compatibility with
    // rich text editors (ProseMirror in Claude, Quill in Gemini)
    try {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(element);
      selection.removeAllRanges();
      selection.addRange(range);
      
      document.execCommand('insertText', false, value);
    } catch (e) {
      console.warn('execCommand insertText failed, falling back to innerText assignment', e);
      element.innerText = value;
      element.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }
}

function injectButtonIfMissing() {
  const inputEl = findInputElement();
  if (!inputEl) return;
  
  // Check if we already injected the button on this input element
  if (inputEl.dataset.alphaInjected === 'true') return;
  
  const parent = inputEl.parentElement;
  if (!parent) return;

  // Double safety: check if parent already has our shadow host
  if (parent.querySelector('#alpha-enhance-host')) {
    inputEl.dataset.alphaInjected = 'true';
    return;
  }

  // Mark input as injected
  inputEl.dataset.alphaInjected = 'true';

  // Ensure parent container has relative positioning
  const parentStyle = window.getComputedStyle(parent);
  if (parentStyle.position === 'static') {
    parent.style.position = 'relative';
  }

  // Create Shadow Host
  const host = document.createElement('div');
  host.id = 'alpha-enhance-host';
  
  // Position styling for different platforms to look native
  host.style.position = 'absolute';
  host.style.zIndex = '9999';
  
  const platform = getPlatform();
  if (platform === 'chatgpt') {
    host.style.bottom = '8px';
    host.style.right = '86px'; // Positioned left of the microphone and send arrow
  } else if (platform === 'claude') {
    host.style.bottom = '8px';
    host.style.right = '56px'; // Left of Claude's sending icons
  } else if (platform === 'gemini') {
    host.style.bottom = '8px';
    host.style.right = '100px'; // Left of Gemini's microphone/image and send controls
  } else {
    host.style.bottom = '8px';
    host.style.right = '12px';
  }

  // Detect host page dark/light mode dynamically based on textarea text color
  let isDark = true;
  try {
    const textStyle = window.getComputedStyle(inputEl);
    const rgbMatch = textStyle.color.match(/\d+/g);
    if (rgbMatch) {
      const r = parseInt(rgbMatch[0], 10);
      const g = parseInt(rgbMatch[1], 10);
      const b = parseInt(rgbMatch[2], 10);
      const brightness = (r * 299 + g * 587 + b * 114) / 1000;
      isDark = brightness > 128; // Bright text indicates a dark background
    }
  } catch (e) {
    // Default to dark theme
  }

  const shadow = host.attachShadow({ mode: 'open' });

  // Load stylesheet inside shadow DOM
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = chrome.runtime.getURL('styles.css');
  shadow.appendChild(link);

  // Injected HTML template
  const container = document.createElement('div');
  container.className = `alpha-container ${isDark ? 'theme-dark' : 'theme-light'}`;
  container.innerHTML = `
    <div class="alpha-tooltip" id="alpha-tooltip">Success</div>
    <button class="alpha-btn" id="alpha-btn">
      <svg class="alpha-icon" viewBox="0 0 24 24">
        <path d="M12 2c0 5.523 4.477 10 10 10-5.523 0-10 4.477-10 10 0-5.523-4.477-10-10-10 5.523 0 10-4.477 10-10z"/>
      </svg>
      <span class="alpha-text">Enhance</span>
    </button>
  `;
  shadow.appendChild(container);

  // Append Host to the parent
  parent.appendChild(host);

  const btn = shadow.getElementById('alpha-btn');
  const tooltip = shadow.getElementById('alpha-tooltip');

  function showTooltip(text, isError = false) {
    tooltip.textContent = text;
    tooltip.className = `alpha-tooltip ${isError ? 'type-error' : 'type-success'} show`;
    setTimeout(() => {
      tooltip.classList.remove('show');
    }, 4000);
  }

  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();

    // Verify if extension is toggled on in the popup
    chrome.storage.local.get({ enabled: true }, (settings) => {
      if (!settings.enabled) {
        showTooltip('Alpha is disabled. Toggle on in the extension menu.', true);
        return;
      }

      let rawText = '';
      if (inputEl.tagName === 'TEXTAREA' || inputEl.tagName === 'INPUT') {
        rawText = inputEl.value;
      } else {
        rawText = inputEl.innerText || inputEl.textContent || '';
      }

      if (!rawText.trim()) {
        showTooltip('Please write a prompt first!', true);
        return;
      }

      // Transition to loading spinner
      btn.classList.add('loading');
      btn.disabled = true;
      shadow.querySelector('.alpha-text').textContent = 'Enhancing...';

      // Send prompt for DLP scrubbing and API optimization
      chrome.runtime.sendMessage({
        action: 'enhancePrompt',
        text: rawText,
        platform: platform
      }, (response) => {
        // Reset loading state
        btn.classList.remove('loading');
        btn.disabled = false;
        shadow.querySelector('.alpha-text').textContent = 'Enhance';

        if (response && response.success) {
          setInputValue(inputEl, response.text);
          let successMessage = 'Prompt Optimized!';
          if (response.redactedThisSession > 0) {
            successMessage = `Redacted ${response.redactedThisSession} keys & Optimized!`;
          } else if (response.cached) {
            successMessage = 'Optimized (Cache Hit!)';
          }
          showTooltip(successMessage);
        } else {
          const errMsg = response ? response.error : 'Gateway server unavailable.';
          showTooltip(errMsg, true);
        }
      });
    });
  });
}

// Watch DOM for changes (LLMs are SPAs with dynamic rendering)
const observer = new MutationObserver(() => {
  injectButtonIfMissing();
});

observer.observe(document.body, { childList: true, subtree: true });

// Run initial injection check
injectButtonIfMissing();
