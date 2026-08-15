(function initializeAlphaFloatingFrame(globalScope) {
  'use strict';

  const {
    captureTrustedActivation,
    createCacheFingerprint,
    createRefinementCoordinator,
    createRequestId,
    envelope,
    isAuthenticatedParentWindowEvent,
    isAuthenticatedPortEvent,
    isNonce,
    isTrustedUserEvent,
    supportedPageOrigin,
    trustedHandler,
    validateBridgeToFrame
  } = globalScope.AlphaFrameProtocol;
  const CLIENT_TIMEOUT_MS = 32_000;
  const BRIDGE_TIMEOUT_MS = 7_000;
  const COLLAPSED_SIZE = 40;
  const PANEL_WIDTH = 430;
  const CONSENT_PANEL_HEIGHT = 520;
  const RESULT_PANEL_HEIGHT = 430;

  const hashParameters = new URLSearchParams(globalScope.location.hash.slice(1));
  const nonceValues = hashParameters.getAll('nonce');
  const nonce = nonceValues.length === 1 ? nonceValues[0] : '';
  const parentOrigin = supportedPageOrigin(document.referrer);
  if (
    !isNonce(nonce) ||
    !parentOrigin ||
    globalScope.location.search ||
    [...hashParameters.keys()].length !== 1
  ) {
    return;
  }
  globalScope.history.replaceState(null, '', globalScope.location.pathname);

  const container = document.getElementById('alpha-container');
  const launcher = document.getElementById('alpha-launcher');
  const launcherLabel = document.getElementById('alpha-launcher-label');
  const panel = document.getElementById('alpha-panel');
  const consentView = document.getElementById('alpha-consent-view');
  const resultView = document.getElementById('alpha-result-view');
  const preview = document.getElementById('alpha-preview');
  const tokenSummary = document.getElementById('alpha-token-summary');
  const protectionSummary = document.getElementById('alpha-protection-summary');
  const useDisclosure = document.getElementById('alpha-use-disclosure');
  const toast = document.getElementById('alpha-toast');
  const promptConsentRow = document.getElementById('alpha-prompt-consent-row');
  const contextConsentRow = document.getElementById('alpha-context-consent-row');
  const promptConsent = document.getElementById('alpha-prompt-consent');
  const contextConsent = document.getElementById('alpha-context-consent');
  const consentAccept = document.getElementById('alpha-consent-accept');
  const retryButton = document.getElementById('alpha-retry');
  const status = document.getElementById('alpha-status');

  let bridgePort = null;
  let channelAccepted = false;
  let channelReady = false;
  let platform = 'generic';
  let platformDisplayName = 'this AI service';
  let isThinking = false;
  let thinkingTimer = null;
  let noticeTimer = null;
  let panelCleanupTimer = null;
  let cachedRefinement = null;
  let lastRawText = '';
  let requestGeneration = 0;
  let pendingConsentRequest = null;
  let launcherDrag = null;
  let panelDrag = null;
  let suppressLauncherClick = false;
  const pendingBridgeRequests = new Map();
  const refinementCoordinator = createRefinementCoordinator();

  launcher.disabled = true;

  const trusted = trustedHandler;

  function shellControl(command, payload) {
    if (!bridgePort || !channelReady) return;
    bridgePort.postMessage(envelope(nonce, 'shell-control', { command, payload }));
  }

  function setShellState(state, width, height) {
    container.dataset.state = state;
    shellControl('layout', { state, width, height });
  }

  function bridgeRequest(command, payload, options = {}) {
    if (!bridgePort || !channelReady) {
      return Promise.reject(new Error('Alpha is still connecting. Try again in a moment.'));
    }
    const requestId = options.requestId || createRequestId(globalScope.crypto);
    if (pendingBridgeRequests.has(requestId)) {
      return Promise.reject(new Error('Alpha rejected a duplicate request.'));
    }
    return new Promise((resolve, reject) => {
      const timeout = globalScope.setTimeout(() => {
        pendingBridgeRequests.delete(requestId);
        reject(new Error(options.timeoutMessage || 'The page bridge took too long to respond.'));
      }, options.timeoutMs || BRIDGE_TIMEOUT_MS);
      pendingBridgeRequests.set(requestId, { command, resolve, reject, timeout });
      bridgePort.postMessage(
        envelope(nonce, 'bridge-request', {
          requestId,
          command,
          payload,
          activation: options.activation || null
        })
      );
    });
  }

  function onPortMessage(event) {
    const rawRequestId = event?.data?.requestId;
    const pending =
      typeof rawRequestId === 'string' ? pendingBridgeRequests.get(rawRequestId) : null;
    const expectedCommand = pending?.command;
    if (
      !isAuthenticatedPortEvent(event, bridgePort, nonce, validateBridgeToFrame, expectedCommand)
    ) {
      return;
    }

    const message = event.data;
    if (message.type === 'bridge-response') {
      globalScope.clearTimeout(pending.timeout);
      pendingBridgeRequests.delete(message.requestId);
      if (message.ok) pending.resolve(message.result);
      else pending.reject(new Error(message.error));
      return;
    }

    if (message.event === 'channel-ready' && !channelReady) {
      channelReady = true;
      platform = message.payload.platform;
      platformDisplayName = message.payload.displayName;
      launcher.disabled = false;
      setShellState('collapsed', COLLAPSED_SIZE, COLLAPSED_SIZE);
    }
  }

  function onChannelInit(event) {
    if (
      channelAccepted ||
      !isAuthenticatedParentWindowEvent(event, globalScope.parent, parentOrigin, nonce) ||
      event.ports?.length !== 1
    ) {
      return;
    }
    const transferredPort = event.ports[0];
    if (!transferredPort || typeof transferredPort.postMessage !== 'function') return;
    channelAccepted = true;
    globalScope.removeEventListener('message', onChannelInit);
    bridgePort = transferredPort;
    bridgePort.addEventListener('message', onPortMessage);
    bridgePort.start();
    bridgePort.postMessage(envelope(nonce, 'channel-ack'));
  }

  function announce(text) {
    status.textContent = '';
    globalScope.requestAnimationFrame(() => {
      status.textContent = text;
    });
  }

  function showNotice(text, isError = false) {
    if (noticeTimer) globalScope.clearTimeout(noticeTimer);
    announce(text);
    if (panel.classList.contains('show')) {
      toast.textContent = text;
      toast.hidden = false;
      noticeTimer = globalScope.setTimeout(() => {
        toast.hidden = true;
        toast.textContent = '';
      }, 4_000);
      return;
    }
    launcherLabel.textContent = text;
    launcherLabel.hidden = false;
    launcher.classList.toggle('notice-error', isError);
    launcher.setAttribute('aria-label', text);
    const width = Math.min(340, Math.max(150, text.length * 6 + 62));
    setShellState('notice', width, COLLAPSED_SIZE);
    noticeTimer = globalScope.setTimeout(() => {
      launcherLabel.hidden = true;
      launcherLabel.textContent = '';
      launcher.classList.remove('notice-error');
      launcher.setAttribute('aria-label', 'Improve prompt');
      setShellState('collapsed', COLLAPSED_SIZE, COLLAPSED_SIZE);
    }, 4_000);
  }

  function consentRequirements(settings) {
    return {
      prompt: settings.privacyConsentVersion !== settings.consentVersion,
      context: Boolean(
        settings.useChatContext && settings.contextConsentVersion !== settings.consentVersion
      )
    };
  }

  function updateConsentButton() {
    const promptRequired = !promptConsentRow.hidden;
    const contextRequired = !contextConsentRow.hidden;
    consentAccept.disabled =
      (promptRequired && !promptConsent.checked) || (contextRequired && !contextConsent.checked);
  }

  function openPanel(view) {
    if (noticeTimer) globalScope.clearTimeout(noticeTimer);
    if (panelCleanupTimer) globalScope.clearTimeout(panelCleanupTimer);
    launcherLabel.hidden = true;
    resultView.hidden = view !== 'result';
    consentView.hidden = view !== 'consent';
    panel.setAttribute('aria-hidden', 'false');
    launcher.setAttribute('aria-expanded', 'true');
    setShellState(
      'expanded',
      PANEL_WIDTH,
      view === 'consent' ? CONSENT_PANEL_HEIGHT : RESULT_PANEL_HEIGHT
    );
    globalScope.requestAnimationFrame(() => {
      globalScope.requestAnimationFrame(() => panel.classList.add('show'));
    });
  }

  function closePanel({ restoreFocus = true, immediate = false } = {}) {
    if (!resultView.hidden && cachedRefinement && preview.value) {
      cachedRefinement.response = { ...cachedRefinement.response, text: preview.value };
    }
    panel.classList.remove('show');
    panel.setAttribute('aria-hidden', 'true');
    launcher.setAttribute('aria-expanded', 'false');
    container.dataset.state = 'closing';
    pendingConsentRequest = null;
    if (panelCleanupTimer) globalScope.clearTimeout(panelCleanupTimer);
    if (immediate) {
      resultView.hidden = true;
      consentView.hidden = true;
      return;
    }
    panelCleanupTimer = globalScope.setTimeout(() => {
      resultView.hidden = true;
      consentView.hidden = true;
      setShellState('collapsed', COLLAPSED_SIZE, COLLAPSED_SIZE);
      if (restoreFocus) launcher.focus({ preventScroll: true });
    }, 440);
  }

  function showConsent(settings, forceRefresh, retryBase = '') {
    const required = consentRequirements(settings);
    pendingConsentRequest = { forceRefresh, retryBase };
    promptConsentRow.hidden = !required.prompt;
    contextConsentRow.hidden = !required.context;
    promptConsent.checked = false;
    contextConsent.checked = false;
    document.getElementById('alpha-consent-title').textContent = required.prompt
      ? 'Before Alpha refines your prompt'
      : 'Allow recent-chat context?';
    updateConsentButton();
    openPanel('consent');
    (required.prompt ? promptConsent : contextConsent).focus({ preventScroll: true });
  }

  function renderRefinement(response) {
    preview.value = response.text;
    tokenSummary.textContent = response.degraded
      ? 'Original prompt restored safely; protected-value integrity was not guaranteed'
      : `~${response.originalEstimatedTokens} → ~${response.estimatedTokens} prompt tokens`;
    protectionSummary.textContent =
      response.redactedThisSession > 0
        ? `${response.redactedThisSession} sensitive value${response.redactedThisSession === 1 ? '' : 's'} protected`
        : response.contextUsed
          ? 'Recent chat included'
          : `${response.taskType || 'Auto'} shaping`;
    const restoredCount = Number(response.restoredSensitiveCount) || 0;
    useDisclosure.hidden = false;
    useDisclosure.textContent =
      restoredCount > 0
        ? `${restoredCount} protected value${restoredCount === 1 ? ' was' : 's were'} restored only inside Alpha’s extension frame. “Copy” places the complete result on the system clipboard, where other apps or clipboard managers may access it. “Use prompt” places ${restoredCount === 1 ? 'it' : 'them'} into ${platformDisplayName}’s composer. That host page controls the composer and may observe or process the draft before you submit it.`
        : '“Copy” places the complete result on the system clipboard, where other apps or clipboard managers may access it. “Use prompt” places the result into the host composer, which that page controls.';
    openPanel('result');
    preview.focus({ preventScroll: true });
  }

  function beginThinking() {
    isThinking = true;
    launcher.disabled = false;
    launcher.classList.remove('notice-error');
    launcher.setAttribute('aria-label', 'Cancel prompt refinement');
    launcher.title = 'Cancel refinement';
    launcherLabel.hidden = false;
    const stages = [
      'Understanding · Cancel',
      'Shaping prompt · Cancel',
      'Checking quality · Cancel'
    ];
    let stage = 0;
    launcherLabel.textContent = stages[stage];
    setShellState('thinking', 190, COLLAPSED_SIZE);
    thinkingTimer = globalScope.setInterval(() => {
      stage = Math.min(stage + 1, stages.length - 1);
      launcherLabel.textContent = stages[stage];
    }, 2_400);
  }

  function stopThinking() {
    if (thinkingTimer) globalScope.clearInterval(thinkingTimer);
    thinkingTimer = null;
    isThinking = false;
    launcher.setAttribute('aria-label', 'Improve prompt');
    launcher.title = 'Improve prompt';
    launcherLabel.hidden = true;
    launcherLabel.textContent = '';
  }

  async function getSettings() {
    return bridgeRequest('get-settings', {});
  }

  async function cancelActiveRequest() {
    if (!refinementCoordinator.requestIds().length) return;
    requestGeneration += 1;
    lastRawText = '';
    pendingConsentRequest = null;
    stopThinking();
    setShellState('collapsed', COLLAPSED_SIZE, COLLAPSED_SIZE);
    await refinementCoordinator.cancelAll((targetRequestId) =>
      bridgeRequest('cancel-enhancement', { targetRequestId }).catch(() => null)
    );
    showNotice('Refinement cancelled');
  }

  async function requestEnhancement(rawText, context, settings, forceRefresh, activation) {
    lastRawText = '';
    let requestId = null;
    let generation = requestGeneration;
    try {
      const cacheKey = await createCacheFingerprint(
        rawText,
        context,
        settings.fingerprint,
        globalScope.crypto
      );
      if (!forceRefresh && cachedRefinement?.key === cacheKey) {
        lastRawText = rawText;
        renderRefinement(cachedRefinement.response);
        return;
      }

      closePanel({ restoreFocus: false, immediate: true });
      requestId = createRequestId(globalScope.crypto);
      generation = ++requestGeneration;
      refinementCoordinator.track(requestId);
      const enhancementRequest = bridgeRequest(
        'enhance-prompt',
        {
          text: rawText,
          platform,
          conversationContext: context,
          bypassCache: forceRefresh
        },
        {
          requestId,
          activation,
          timeoutMs: CLIENT_TIMEOUT_MS,
          timeoutMessage: 'Alpha took too long to respond. Try again.'
        }
      );
      beginThinking();
      const { response } = await enhancementRequest;
      if (generation !== requestGeneration) return;
      if (!response.success) {
        if (response.code === 'CONSENT_REQUIRED' || response.code === 'CONTEXT_CONSENT_REQUIRED') {
          const refreshedSettings = await getSettings();
          showConsent(refreshedSettings, forceRefresh);
          return;
        }
        throw Object.assign(new Error(response.error), { code: response.code });
      }
      cachedRefinement = { key: cacheKey, response };
      lastRawText = rawText;
      renderRefinement(response);
    } catch (error) {
      lastRawText = '';
      if (generation === requestGeneration) {
        if (error.message === 'Alpha took too long to respond. Try again.') {
          refinementCoordinator
            .cancelAll((targetRequestId) =>
              bridgeRequest('cancel-enhancement', { targetRequestId }).catch(() => null)
            )
            .catch(() => {});
        }
        stopThinking();
        showNotice(error.message || 'Alpha is temporarily unavailable.', true);
      }
    } finally {
      if (requestId) refinementCoordinator.untrack(requestId);
      if (generation === requestGeneration && isThinking) stopThinking();
    }
  }

  async function refineCurrentPrompt(forceRefresh = false, retryBase = '', activation = null) {
    if (!refinementCoordinator.acquire()) return;
    lastRawText = '';
    launcher.disabled = true;
    retryButton.disabled = true;
    try {
      const settings = await getSettings();
      if (!settings.enabled) {
        showNotice('Alpha is disabled. Turn it on from the extension menu.', true);
        return;
      }
      const required = consentRequirements(settings);
      if (required.prompt || required.context) {
        showConsent(settings, forceRefresh, retryBase);
        return;
      }

      let rawText = retryBase;
      if (!retryBase) {
        const collected = await bridgeRequest(
          'collect-input',
          {
            includeContext: false
          },
          {
            activation
          }
        );
        rawText = collected.rawText;
        platform = collected.platform;
        platformDisplayName = collected.displayName;
      }

      if (!rawText.trim()) {
        showNotice('Write a prompt first.', true);
        return;
      }
      let context = '';
      if (settings.useChatContext) {
        ({ context } = await bridgeRequest('collect-context', {}, { activation }));
      }
      await requestEnhancement(rawText, context, settings, forceRefresh, activation);
    } catch (error) {
      lastRawText = '';
      showNotice(error.message || 'Alpha is temporarily unavailable.', true);
    } finally {
      refinementCoordinator.release();
      retryButton.disabled = false;
      launcher.disabled = !channelReady;
    }
  }

  for (const button of document.querySelectorAll('[data-alpha-close]')) {
    button.addEventListener(
      'click',
      trusted(() => closePanel())
    );
  }

  promptConsent.addEventListener('change', trusted(updateConsentButton));
  contextConsent.addEventListener('change', trusted(updateConsentButton));
  document.getElementById('alpha-consent-decline').addEventListener(
    'click',
    trusted(() => closePanel())
  );
  document.getElementById('alpha-privacy-details').addEventListener('click', (event) => {
    if (!isTrustedUserEvent(event)) event.preventDefault();
  });
  consentAccept.addEventListener(
    'click',
    trusted(async (event) => {
      if (consentAccept.disabled || !pendingConsentRequest) return;
      const activation = captureTrustedActivation(event);
      const request = pendingConsentRequest;
      pendingConsentRequest = null;
      try {
        await bridgeRequest(
          'save-consent',
          {
            prompt: !promptConsentRow.hidden && promptConsent.checked,
            context: !contextConsentRow.hidden && contextConsent.checked,
            acceptedAt: new Date().toISOString()
          },
          { activation }
        );
        closePanel({ restoreFocus: false, immediate: true });
        await refineCurrentPrompt(request.forceRefresh, request.retryBase, activation);
      } catch (error) {
        showNotice(error.message || 'Alpha could not save your choice.', true);
      }
    })
  );

  function beginDrag(event, kind, handle) {
    if (event.button !== 0) return;
    const state = {
      pointerId: event.pointerId,
      lastScreenX: event.screenX,
      lastScreenY: event.screenY,
      moved: false,
      handle
    };
    if (kind === 'launcher') launcherDrag = state;
    else panelDrag = state;
    handle.setPointerCapture(event.pointerId);
    shellControl('move', {
      phase: 'start',
      deltaX: 0,
      deltaY: 0,
      trustedAction: true
    });
  }

  function moveDrag(event, drag) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const deltaX = event.screenX - drag.lastScreenX;
    const deltaY = event.screenY - drag.lastScreenY;
    if (!drag.moved && Math.hypot(deltaX, deltaY) < 3) return;
    drag.moved = true;
    drag.lastScreenX = event.screenX;
    drag.lastScreenY = event.screenY;
    shellControl('move', {
      phase: 'move',
      deltaX,
      deltaY,
      trustedAction: true
    });
    event.preventDefault();
  }

  function finishDrag(event, kind) {
    const drag = kind === 'launcher' ? launcherDrag : panelDrag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (drag.handle.hasPointerCapture(event.pointerId)) {
      drag.handle.releasePointerCapture(event.pointerId);
    }
    shellControl('move', {
      phase: 'end',
      deltaX: 0,
      deltaY: 0,
      trustedAction: true
    });
    if (kind === 'launcher') {
      suppressLauncherClick = drag.moved;
      launcher.classList.remove('dragging');
      launcherDrag = null;
    } else {
      panelDrag = null;
    }
  }

  launcher.addEventListener(
    'pointerdown',
    trusted((event) => {
      if (event.button !== 0 || isThinking || panel.classList.contains('show')) return;
      launcher.classList.add('dragging');
      beginDrag(event, 'launcher', launcher);
    })
  );
  launcher.addEventListener(
    'pointermove',
    trusted((event) => moveDrag(event, launcherDrag))
  );
  launcher.addEventListener(
    'pointerup',
    trusted((event) => finishDrag(event, 'launcher'))
  );
  launcher.addEventListener(
    'pointercancel',
    trusted((event) => finishDrag(event, 'launcher'))
  );

  launcher.addEventListener(
    'contextmenu',
    trusted((event) => {
      event.preventDefault();
      shellControl('reset-position', { trustedAction: true });
      showNotice('Bubble reset beside the composer');
    })
  );
  launcher.addEventListener(
    'keydown',
    trusted((event) => {
      if (event.altKey && event.key === 'Home') {
        event.preventDefault();
        shellControl('reset-position', { trustedAction: true });
        showNotice('Bubble reset beside the composer');
        return;
      }
      if (!event.altKey || !event.key.startsWith('Arrow')) return;
      event.preventDefault();
      const step = event.shiftKey ? 24 : 8;
      shellControl('move', {
        phase: 'move',
        deltaX: event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0,
        deltaY: event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0,
        trustedAction: true
      });
      shellControl('move', {
        phase: 'end',
        deltaX: 0,
        deltaY: 0,
        trustedAction: true
      });
    })
  );

  for (const handle of document.querySelectorAll('[data-alpha-drag-handle]')) {
    handle.addEventListener(
      'pointerdown',
      trusted((event) => {
        if (event.target.closest('button, a, input, textarea')) return;
        beginDrag(event, 'panel', handle);
        event.preventDefault();
      })
    );
    handle.addEventListener(
      'pointermove',
      trusted((event) => moveDrag(event, panelDrag))
    );
    handle.addEventListener(
      'pointerup',
      trusted((event) => finishDrag(event, 'panel'))
    );
    handle.addEventListener(
      'pointercancel',
      trusted((event) => finishDrag(event, 'panel'))
    );
  }

  document.getElementById('alpha-copy').addEventListener(
    'click',
    trusted(async () => {
      try {
        await navigator.clipboard.writeText(preview.value);
        showNotice('Refined prompt copied');
      } catch (_error) {
        preview.focus();
        preview.select();
        announce('Clipboard access was blocked. Press Ctrl/Cmd+C to copy.');
      }
    })
  );
  retryButton.addEventListener(
    'click',
    trusted((event) => {
      if (!isThinking && lastRawText) {
        refineCurrentPrompt(true, lastRawText, captureTrustedActivation(event));
      }
    })
  );
  document.getElementById('alpha-use').addEventListener(
    'click',
    trusted(async (event) => {
      try {
        if (!preview.value.trim() || preview.value.length > 30_000) {
          showNotice('Keep the refined prompt between 1 and 30,000 characters.', true);
          return;
        }
        await bridgeRequest(
          'set-composer',
          { text: preview.value },
          {
            activation: captureTrustedActivation(event)
          }
        );
        closePanel({ restoreFocus: false, immediate: true });
        showNotice('Professional prompt ready');
      } catch (error) {
        showNotice(error.message || 'Alpha could not update this chat input.', true);
      }
    })
  );

  launcher.addEventListener(
    'click',
    trusted(async (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (suppressLauncherClick) {
        suppressLauncherClick = false;
        return;
      }
      if (isThinking) {
        await cancelActiveRequest();
        return;
      }
      if (panel.classList.contains('show')) {
        closePanel();
        return;
      }
      await refineCurrentPrompt(false, '', captureTrustedActivation(event));
    })
  );

  panel.addEventListener(
    'keydown',
    trusted((event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closePanel();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(
        panel.querySelectorAll('button:not([disabled]), textarea, input:not([disabled]), a[href]')
      ).filter((element) => !element.closest('[hidden]'));
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    })
  );

  globalScope.addEventListener('message', onChannelInit);
})(globalThis);
