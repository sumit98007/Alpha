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

function collectConversationContext() {
  const platform = getPlatform();
  const selectors = {
    chatgpt: '[data-message-author-role]',
    claude: '[data-testid="user-message"], [data-testid="assistant-message"], .font-claude-message',
    gemini: 'user-query, model-response'
  };
  const selector = selectors[platform];
  if (!selector) return '';

  const composer = findInputElement();
  const seen = new Set();
  const messages = [];
  for (const element of document.querySelectorAll(selector)) {
    if (composer && (element === composer || element.contains(composer))) continue;
    const text = (element.innerText || element.textContent || '').trim();
    if (!text || text.length > 12000 || seen.has(text)) continue;
    seen.add(text);

    const explicitRole = element.getAttribute('data-message-author-role') ||
      element.getAttribute('data-testid') || element.tagName.toLowerCase();
    const role = /user|query/i.test(explicitRole) ? 'User' : 'Assistant';
    messages.push(`${role}: ${text}`);
  }

  return messages.slice(-8).join('\n\n').slice(-12000);
}

function injectButtonIfMissing() {
  const inputEl = findInputElement();
  if (!inputEl) return;
  if (document.getElementById('alpha-enhance-host')) return;

  // Create Shadow Host
  const host = document.createElement('div');
  host.id = 'alpha-enhance-host';
  host.style.position = 'fixed';
  host.style.zIndex = '9999';

  const platform = getPlatform();

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
    <button class="alpha-launcher" id="alpha-launcher" aria-label="Improve prompt" title="Improve prompt">
      <svg class="alpha-launcher-icon" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 2c0 5.523 4.477 10 10 10-5.523 0-10 4.477-10 10 0-5.523-4.477-10-10-10 5.523 0 10-4.477 10-10z"/>
      </svg>
      <span class="alpha-thinking-label" id="alpha-thinking-label" hidden>Understanding</span>
    </button>
    <section class="alpha-panel" id="alpha-panel" aria-hidden="true">
      <div class="alpha-result-view" id="alpha-result-view">
        <div class="alpha-panel-header" id="alpha-panel-header" title="Drag to move">
          <div>
            <div class="alpha-eyebrow">ALPHA REFINED</div>
            <div class="alpha-panel-title">Review your professional prompt</div>
          </div>
          <button class="alpha-icon-btn" data-alpha-close aria-label="Collapse preview">−</button>
        </div>
        <textarea class="alpha-preview" id="alpha-preview" spellcheck="true"></textarea>
        <div class="alpha-meta">
          <span id="alpha-token-summary">Token estimate unavailable</span>
          <span id="alpha-protection-summary">Protected locally</span>
        </div>
        <div class="alpha-actions">
          <button class="alpha-secondary-btn" id="alpha-copy">Copy</button>
          <button class="alpha-secondary-btn alpha-retry-btn" id="alpha-retry">Try again</button>
          <button class="alpha-primary-btn" id="alpha-use">Use prompt</button>
        </div>
      </div>
    </section>
  `;
  shadow.appendChild(container);

  // Keep Alpha independent from the host composer's layout and lifecycle.
  document.body.appendChild(host);

  const launcher = shadow.getElementById('alpha-launcher');
  const thinkingLabel = shadow.getElementById('alpha-thinking-label');
  const tooltip = shadow.getElementById('alpha-tooltip');
  const panel = shadow.getElementById('alpha-panel');
  const panelHeader = shadow.getElementById('alpha-panel-header');
  const preview = shadow.getElementById('alpha-preview');
  const tokenSummary = shadow.getElementById('alpha-token-summary');
  const protectionSummary = shadow.getElementById('alpha-protection-summary');
  const copyButton = shadow.getElementById('alpha-copy');
  const retryButton = shadow.getElementById('alpha-retry');
  const useButton = shadow.getElementById('alpha-use');
  let isThinking = false;
  let thinkingTimer = null;
  let observedInput = null;
  let dragState = null;
  let launcherDragState = null;
  let manualLauncherPosition = null;
  let suppressLauncherClick = false;
  let lastRawText = '';
  let panelCleanupTimer = null;
  let cachedRefinement = null;

  chrome.storage.local.get({ floatingPosition: null }, (settings) => {
    if (settings.floatingPosition &&
        Number.isFinite(settings.floatingPosition.x) &&
        Number.isFinite(settings.floatingPosition.y)) {
      manualLauncherPosition = settings.floatingPosition;
      schedulePosition();
    }
  });

  const inputResizeObserver = typeof ResizeObserver === 'function'
    ? new ResizeObserver(() => schedulePosition())
    : null;

  function observeCurrentInput(input) {
    if (!inputResizeObserver || input === observedInput) return;
    if (observedInput) inputResizeObserver.unobserve(observedInput);
    observedInput = input;
    inputResizeObserver.observe(input);
  }

  function positionFloatingHost() {
    const currentInput = findInputElement();
    if (!currentInput) {
      host.style.display = 'none';
      return;
    }
    host.style.display = 'block';
    observeCurrentInput(currentInput);

    const launcherSize = 44;
    if (manualLauncherPosition) {
      const maxLeft = Math.max(12, window.innerWidth - launcherSize - 12);
      const maxTop = Math.max(12, window.innerHeight - launcherSize - 12);
      host.style.left = `${Math.min(Math.max(12, manualLauncherPosition.x * window.innerWidth), maxLeft)}px`;
      host.style.top = `${Math.min(Math.max(12, manualLauncherPosition.y * window.innerHeight), maxTop)}px`;
      host.style.right = 'auto';
      host.style.bottom = 'auto';
      host.style.transform = 'none';
      if (panel.classList.contains('show')) fitPanelToViewport();
      return;
    }

    const rect = currentInput.getBoundingClientRect();
    const left = Math.min(
      Math.max(rect.right - launcherSize, 12),
      window.innerWidth - launcherSize - 12
    );
    const roomBelow = window.innerHeight - rect.bottom;
    const top = roomBelow >= launcherSize + 18
      ? rect.bottom + 10
      : Math.max(10, rect.top - launcherSize - 10);

    host.style.left = `${left}px`;
    host.style.top = `${top}px`;
    host.style.right = 'auto';
    host.style.bottom = 'auto';
    host.style.transform = 'none';

    if (!panel.classList.contains('detached')) {
      const roomAboveLauncher = top;
      panel.classList.toggle('panel-below', roomAboveLauncher < 330 && roomBelow > roomAboveLauncher);
    }
    if (panel.classList.contains('show')) fitPanelToViewport();
  }

  let positionFrame = 0;
  function schedulePosition() {
    if (positionFrame) return;
    positionFrame = requestAnimationFrame(() => {
      positionFrame = 0;
      positionFloatingHost();
    });
  }

  host._alphaReposition = schedulePosition;

  positionFloatingHost();
  schedulePosition();

  function closePreview() {
    if (cachedRefinement && preview.value) {
      cachedRefinement.response = { ...cachedRefinement.response, text: preview.value };
    }
    panel.classList.remove('show');
    panel.setAttribute('aria-hidden', 'true');
    launcher.setAttribute('aria-expanded', 'false');
    container.dataset.state = 'collapsed';
    if (panelCleanupTimer) clearTimeout(panelCleanupTimer);
    panelCleanupTimer = setTimeout(() => {
      if (panel.classList.contains('show')) return;
      panel.classList.remove('detached', 'viewport-fit');
      panel.style.left = '';
      panel.style.top = '';
      panel.style.right = '';
      panel.style.bottom = '';
      panel.style.width = '';
      panel.style.maxHeight = '';
    }, 440);
    schedulePosition();
  }

  shadow.querySelectorAll('[data-alpha-close]').forEach((button) => {
    button.addEventListener('click', closePreview);
  });

  function openPanel() {
    if (panelCleanupTimer) clearTimeout(panelCleanupTimer);
    fitPanelToViewport();
    // Commit the collapsed geometry before starting the morph animation.
    panel.getBoundingClientRect();
    panel.classList.add('show');
    panel.setAttribute('aria-hidden', 'false');
    launcher.setAttribute('aria-expanded', 'true');
    container.dataset.state = 'expanded';
    schedulePosition();
  }

  function fitPanelToViewport() {
    const margin = 12;
    const bubbleRect = launcher.getBoundingClientRect();
    const panelWidth = Math.min(420, window.innerWidth - margin * 2);
    const panelMaxHeight = Math.max(220, window.innerHeight - margin * 2);

    panel.classList.add('viewport-fit');
    panel.style.width = `${panelWidth}px`;
    panel.style.maxHeight = `${panelMaxHeight}px`;

    const measuredHeight = Math.min(panel.scrollHeight || 420, panelMaxHeight);
    const bubbleCenterX = bubbleRect.left + bubbleRect.width / 2;
    const bubbleCenterY = bubbleRect.top + bubbleRect.height / 2;
    const maxLeft = Math.max(margin, window.innerWidth - panelWidth - margin);
    const maxTop = Math.max(margin, window.innerHeight - measuredHeight - margin);

    const preferredLeft = bubbleRect.right - panelWidth;
    const left = Math.min(Math.max(margin, preferredLeft), maxLeft);
    const roomAbove = bubbleRect.bottom - margin;
    const roomBelow = window.innerHeight - bubbleRect.top - margin;
    let top;
    if (roomAbove >= measuredHeight) {
      top = bubbleRect.bottom - measuredHeight;
    } else if (roomBelow >= measuredHeight) {
      top = bubbleRect.top;
    } else {
      top = bubbleCenterY - measuredHeight / 2;
    }
    top = Math.min(Math.max(margin, top), maxTop);

    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    panel.style.setProperty('--alpha-origin-x', `${Math.min(Math.max(20, bubbleCenterX - left), panelWidth - 20)}px`);
    panel.style.setProperty('--alpha-origin-y', `${Math.min(Math.max(20, bubbleCenterY - top), measuredHeight - 20)}px`);
  }

  function renderRefinement(response) {
    preview.value = response.text;
    tokenSummary.textContent =
      response.degraded
        ? 'Original prompt restored safely; optimization could not preserve protected values'
        : `~${response.originalEstimatedTokens} → ~${response.estimatedTokens} prompt tokens`;
    protectionSummary.textContent = response.redactedThisSession > 0
      ? `${response.redactedThisSession} sensitive value${response.redactedThisSession === 1 ? '' : 's'} protected`
      : response.contextUsed
        ? 'Recent chat included'
        : `${response.taskType || 'Auto'} shaping`;
    openPanel();
    preview.focus();
  }

  function requestEnhancement(rawText, forceRefresh = false) {
    lastRawText = rawText;
    chrome.storage.local.get({ useChatContext: false }, (contextSettings) => {
      const conversationContext = contextSettings.useChatContext
        ? collectConversationContext()
        : '';
      const cacheKey = `${rawText}\u0000${conversationContext}`;
      if (!forceRefresh && cachedRefinement?.key === cacheKey) {
        renderRefinement(cachedRefinement.response);
        return;
      }

      closePreview();
      isThinking = true;
      launcher.disabled = true;
      launcher.classList.add('thinking');
      thinkingLabel.hidden = false;
      const stages = ['Understanding', 'Shaping prompt', 'Checking quality'];
      let stageIndex = 0;
      thinkingTimer = setInterval(() => {
        stageIndex = Math.min(stageIndex + 1, stages.length - 1);
        thinkingLabel.textContent = stages[stageIndex];
        positionFloatingHost();
      }, 2400);
      positionFloatingHost();

      chrome.runtime.sendMessage({
        action: 'enhancePrompt',
        text: rawText,
        platform: platform,
        conversationContext
      }, (response) => {
      stopThinking();

      if (response && response.success) {
        cachedRefinement = { key: cacheKey, response };
        renderRefinement(response);
      } else {
        const errMsg = response ? response.error : 'Gateway server unavailable.';
        showTooltip(errMsg, true);
      }
      });
    });
  }

  launcher.setAttribute('aria-expanded', 'false');
  launcher.setAttribute('aria-controls', 'alpha-panel');
  container.dataset.state = 'collapsed';

  launcher.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || isThinking || panel.classList.contains('show')) return;
    const rect = host.getBoundingClientRect();
    launcherDragState = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      moved: false
    };
    launcher.setPointerCapture(event.pointerId);
  });

  launcher.addEventListener('pointermove', (event) => {
    if (!launcherDragState || event.pointerId !== launcherDragState.pointerId) return;
    const distance = Math.hypot(
      event.clientX - launcherDragState.startX,
      event.clientY - launcherDragState.startY
    );
    if (distance < 5 && !launcherDragState.moved) return;

    launcherDragState.moved = true;
    launcher.classList.add('dragging');
    const maxLeft = Math.max(12, window.innerWidth - 52);
    const maxTop = Math.max(12, window.innerHeight - 52);
    const left = Math.min(Math.max(12, event.clientX - launcherDragState.offsetX), maxLeft);
    const top = Math.min(Math.max(12, event.clientY - launcherDragState.offsetY), maxTop);
    host.style.left = `${left}px`;
    host.style.top = `${top}px`;
    event.preventDefault();
  });

  launcher.addEventListener('pointerup', (event) => {
    if (!launcherDragState || event.pointerId !== launcherDragState.pointerId) return;
    launcher.releasePointerCapture(event.pointerId);
    if (launcherDragState.moved) {
      const rect = host.getBoundingClientRect();
      manualLauncherPosition = {
        x: rect.left / window.innerWidth,
        y: rect.top / window.innerHeight
      };
      chrome.storage.local.set({ floatingPosition: manualLauncherPosition });
      suppressLauncherClick = true;
      showTooltip('Bubble position saved');
    }
    launcher.classList.remove('dragging');
    launcherDragState = null;
  });

  launcher.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    event.stopPropagation();
    manualLauncherPosition = null;
    chrome.storage.local.remove('floatingPosition');
    schedulePosition();
    showTooltip('Bubble reset beside the composer');
  });

  panelHeader.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || event.target.closest('button')) return;
    const rect = panel.getBoundingClientRect();
    dragState = {
      pointerId: event.pointerId,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top
    };
    panel.classList.add('detached');
    panel.style.left = `${rect.left}px`;
    panel.style.top = `${rect.top}px`;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    panelHeader.setPointerCapture(event.pointerId);
    event.preventDefault();
  });

  panelHeader.addEventListener('pointermove', (event) => {
    if (!dragState || event.pointerId !== dragState.pointerId) return;
    const panelRect = panel.getBoundingClientRect();
    const maxLeft = Math.max(8, window.innerWidth - panelRect.width - 8);
    const maxTop = Math.max(8, window.innerHeight - panelRect.height - 8);
    panel.style.left = `${Math.min(Math.max(8, event.clientX - dragState.offsetX), maxLeft)}px`;
    panel.style.top = `${Math.min(Math.max(8, event.clientY - dragState.offsetY), maxTop)}px`;
  });

  panelHeader.addEventListener('pointerup', (event) => {
    if (!dragState || event.pointerId !== dragState.pointerId) return;
    panelHeader.releasePointerCapture(event.pointerId);
    dragState = null;
  });

  copyButton.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(preview.value);
      showTooltip('Refined prompt copied');
    } catch (err) {
      preview.select();
      document.execCommand('copy');
      showTooltip('Refined prompt copied');
    }
  });

  retryButton.addEventListener('click', () => {
    if (isThinking || !lastRawText) return;
    requestEnhancement(lastRawText, true);
  });

  useButton.addEventListener('click', () => {
    const activeInput = findInputElement();
    if (!activeInput) {
      showTooltip('Chat input is unavailable.', true);
      return;
    }
    setInputValue(activeInput, preview.value);
    closePreview();
    showTooltip('Professional prompt ready');
  });

  function showTooltip(text, isError = false) {
    tooltip.textContent = text;
    tooltip.className = `alpha-tooltip ${isError ? 'type-error' : 'type-success'} show`;
    setTimeout(() => {
      tooltip.classList.remove('show');
    }, 4000);
  }

  function stopThinking() {
    if (thinkingTimer) clearInterval(thinkingTimer);
    thinkingTimer = null;
    isThinking = false;
    launcher.disabled = false;
    launcher.classList.remove('thinking');
    thinkingLabel.hidden = true;
    thinkingLabel.textContent = 'Understanding';
    positionFloatingHost();
  }

  launcher.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();

    if (suppressLauncherClick) {
      suppressLauncherClick = false;
      return;
    }

    if (isThinking) return;
    if (panel.classList.contains('show')) {
      closePreview();
      return;
    }

    // Verify if extension is toggled on in the popup
    chrome.storage.local.get({ enabled: true }, (settings) => {
      if (!settings.enabled) {
        showTooltip('Alpha is disabled. Toggle on in the extension menu.', true);
        return;
      }

      const activeInput = findInputElement();
      if (!activeInput) {
        showTooltip('Chat input is unavailable.', true);
        return;
      }

      let rawText = '';
      if (activeInput.tagName === 'TEXTAREA' || activeInput.tagName === 'INPUT') {
        rawText = activeInput.value;
      } else {
        rawText = activeInput.innerText || activeInput.textContent || '';
      }

      if (!rawText.trim()) {
        showTooltip('Write a prompt first.', true);
        return;
      }

      requestEnhancement(rawText);
    });
  });

  window.addEventListener('resize', schedulePosition, { passive: true });
  window.addEventListener('scroll', schedulePosition, { passive: true, capture: true });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && panel.classList.contains('show')) closePreview();
  });
}

// Watch DOM for changes (LLMs are SPAs with dynamic rendering)
const observer = new MutationObserver(() => {
  injectButtonIfMissing();
  const host = document.getElementById('alpha-enhance-host');
  if (host && typeof host._alphaReposition === 'function') host._alphaReposition();
});

observer.observe(document.body, { childList: true, subtree: true });

// Run initial injection check
injectButtonIfMissing();
