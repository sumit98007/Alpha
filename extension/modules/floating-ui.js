(function initializeAlphaFloatingUi(globalScope) {
  'use strict';

  const { collectConversationContext, composerValue, findComposer, setComposerValue } =
    globalScope.AlphaPlatforms;
  const {
    MAX_CONTEXT_CHARACTERS,
    MAX_PROMPT_CHARACTERS,
    createNonce,
    envelope,
    extensionOrigin,
    isAuthenticatedPortEvent,
    validateBridgeToFrame,
    validateFrameToBridge
  } = globalScope.AlphaFrameProtocol;
  const { sendMessage } = globalScope.AlphaRuntime;
  const VIEWPORT_MARGIN = 12;
  const COLLAPSED_SIZE = 40;
  const ACTIVATION_MAX_AGE_MS = 5_000;
  const ACTIVATION_FUTURE_SKEW_MS = 250;
  const HOST_STATIC_STYLES = Object.freeze({
    position: 'fixed',
    zIndex: '2147483647',
    display: 'block',
    visibility: 'visible',
    opacity: '1',
    pointerEvents: 'auto',
    transform: 'none',
    translate: 'none',
    scale: 'none',
    rotate: 'none',
    clip: 'auto',
    clipPath: 'none',
    filter: 'none',
    mask: 'none',
    mixBlendMode: 'normal',
    isolation: 'isolate',
    overflow: 'visible',
    margin: '0px',
    padding: '0px',
    border: '0px',
    background: 'transparent',
    colorScheme: 'normal'
  });

  function panelViewportBounds(viewportWidth, viewportHeight) {
    const marginX = Math.min(VIEWPORT_MARGIN, Math.max(0, (viewportWidth - 1) / 2));
    const marginY = Math.min(VIEWPORT_MARGIN, Math.max(0, (viewportHeight - 1) / 2));
    return {
      marginX,
      marginY,
      width: Math.max(1, viewportWidth - marginX * 2),
      height: Math.max(1, viewportHeight - marginY * 2)
    };
  }

  function clamp(value, minimum, maximum) {
    return Math.min(Math.max(minimum, value), Math.max(minimum, maximum));
  }

  function boundedError(error, fallback) {
    const message = typeof error?.message === 'string' ? error.message.trim() : '';
    return (message || fallback).slice(0, 240);
  }

  function cssPropertyName(property) {
    return property.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
  }

  function create(adapter = globalScope.AlphaPlatforms.current()) {
    const input = findComposer(adapter);
    if (!input) return null;

    const nonce = createNonce(globalScope.crypto);
    const trustedExtensionOrigin = extensionOrigin(globalScope.chrome.runtime);
    const host = document.createElement('div');
    for (const [property, value] of Object.entries({
      ...HOST_STATIC_STYLES,
      width: `${COLLAPSED_SIZE}px`,
      height: `${COLLAPSED_SIZE}px`
    })) {
      host.style.setProperty(cssPropertyName(property), value, 'important');
    }

    // A closed shell prevents the host page from reading the frame URL (and its nonce)
    // or styling interactive controls. Sensitive values exist only in the extension frame
    // and in the isolated bridge's short-lived message handlers, never in page-owned DOM.
    const shell = host.attachShadow({ mode: 'closed' });
    const frame = document.createElement('iframe');
    frame.title = 'Alpha prompt refinement';
    frame.setAttribute('allow', 'clipboard-write');
    frame.referrerPolicy = 'origin';
    frame.addEventListener('load', onFrameLoad);
    frame.src = `${globalScope.chrome.runtime.getURL('floating-frame.html')}#nonce=${nonce}`;
    for (const [property, value] of Object.entries({
      display: 'block',
      width: '100%',
      height: '100%',
      margin: '0',
      padding: '0',
      border: '0',
      borderRadius: '0',
      background: 'transparent',
      colorScheme: 'normal'
    })) {
      frame.style.setProperty(cssPropertyName(property), value, 'important');
    }
    shell.appendChild(frame);
    document.body.appendChild(host);

    let bridgePort = null;
    let channelEstablished = false;
    let observedInput = null;
    let positionFrame = 0;
    let manualBubblePosition = null;
    let layout = { state: 'collapsed', width: COLLAPSED_SIZE, height: COLLAPSED_SIZE };
    let destroyed = false;
    let expectedRect = { left: 0, top: 0, width: COLLAPSED_SIZE, height: COLLAPSED_SIZE };
    let expectedVisible = true;
    let lastTamperAt = 0;
    let canonicalInlineValues = new Map();
    const processedRequestIds = new Set();
    const verifiedActivations = new Map();

    const inputResizeObserver =
      typeof ResizeObserver === 'function' ? new ResizeObserver(schedulePosition) : null;
    const hostAttributeObserver =
      typeof MutationObserver === 'function'
        ? new MutationObserver((records) => {
            if (destroyed || !records.length) return;
            lastTamperAt = Date.now();
            verifiedActivations.clear();
            applyCanonicalHostGeometry(expectedRect, expectedVisible);
            schedulePosition();
          })
        : null;

    function observeHostAttributes() {
      hostAttributeObserver?.observe(host, {
        attributes: true
      });
    }

    function applyCanonicalHostGeometry(rect, visible = true) {
      hostAttributeObserver?.disconnect();
      host.removeAttribute('id');
      for (const attribute of host.getAttributeNames?.() || []) {
        if (attribute !== 'style') host.removeAttribute(attribute);
      }
      host.removeAttribute('style');
      expectedRect = {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height
      };
      expectedVisible = visible;
      const styles = {
        ...HOST_STATIC_STYLES,
        display: visible ? 'block' : 'none',
        width: `${rect.width}px`,
        height: `${rect.height}px`,
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        right: 'auto',
        bottom: 'auto'
      };
      for (const [property, value] of Object.entries(styles)) {
        host.style.setProperty(cssPropertyName(property), value, 'important');
      }
      canonicalInlineValues = new Map(
        Object.keys(styles).map((property) => {
          const name = cssPropertyName(property);
          return [
            name,
            {
              priority: host.style.getPropertyPriority(name),
              value: host.style.getPropertyValue(name)
            }
          ];
        })
      );
      observeHostAttributes();
    }

    function observeComposer(composer) {
      if (!inputResizeObserver || composer === observedInput) return;
      if (observedInput) inputResizeObserver.unobserve(observedInput);
      observedInput = composer;
      inputResizeObserver.observe(composer);
    }

    function shellRect() {
      return {
        ...expectedRect,
        right: expectedRect.left + expectedRect.width,
        bottom: expectedRect.top + expectedRect.height
      };
    }

    function currentBubblePosition() {
      const rect = shellRect();
      return {
        left: rect.right - COLLAPSED_SIZE,
        top: rect.bottom - COLLAPSED_SIZE
      };
    }

    function normalizedBubblePosition() {
      const bubble = currentBubblePosition();
      return {
        x: clamp(bubble.left / Math.max(1, globalScope.innerWidth), 0, 1),
        y: clamp(bubble.top / Math.max(1, globalScope.innerHeight), 0, 1)
      };
    }

    function postBridgeEvent(event, payload) {
      if (destroyed || !bridgePort) return;
      bridgePort.postMessage(envelope(nonce, 'bridge-event', { event, payload }));
    }

    function announcePosition() {
      const position = normalizedBubblePosition();
      manualBubblePosition = position;
      postBridgeEvent('position', position);
      sendMessage({ action: 'saveFloatingPosition', position }).catch(() => {});
    }

    function autoBubblePosition(composer, bounds) {
      const rect = composer.getBoundingClientRect();
      const left = clamp(
        rect.right - COLLAPSED_SIZE,
        bounds.marginX,
        globalScope.innerWidth - COLLAPSED_SIZE - bounds.marginX
      );
      const roomBelow = globalScope.innerHeight - rect.bottom;
      const preferredTop =
        roomBelow >= COLLAPSED_SIZE + 18 ? rect.bottom + 10 : rect.top - COLLAPSED_SIZE - 10;
      return {
        left,
        top: clamp(
          preferredTop,
          bounds.marginY,
          globalScope.innerHeight - COLLAPSED_SIZE - bounds.marginY
        )
      };
    }

    function positionFloatingHost() {
      if (destroyed) return;
      const composer = findComposer(adapter);
      if (!composer) {
        applyCanonicalHostGeometry(expectedRect, false);
        return;
      }
      observeComposer(composer);

      const bounds = panelViewportBounds(globalScope.innerWidth, globalScope.innerHeight);
      const width = Math.min(layout.width, bounds.width);
      const height = Math.min(layout.height, bounds.height);
      const current = shellRect();
      let bubble;
      if (manualBubblePosition) {
        bubble = {
          left: clamp(
            manualBubblePosition.x * globalScope.innerWidth,
            bounds.marginX,
            globalScope.innerWidth - COLLAPSED_SIZE - bounds.marginX
          ),
          top: clamp(
            manualBubblePosition.y * globalScope.innerHeight,
            bounds.marginY,
            globalScope.innerHeight - COLLAPSED_SIZE - bounds.marginY
          )
        };
      } else if (layout.state === 'expanded' && current.width > 0 && current.height > 0) {
        bubble = currentBubblePosition();
      } else {
        bubble = autoBubblePosition(composer, bounds);
      }

      const left = clamp(
        bubble.left + COLLAPSED_SIZE - width,
        bounds.marginX,
        globalScope.innerWidth - width - bounds.marginX
      );
      const top = clamp(
        bubble.top + COLLAPSED_SIZE - height,
        bounds.marginY,
        globalScope.innerHeight - height - bounds.marginY
      );
      applyCanonicalHostGeometry({ left, top, width, height });
      postBridgeEvent('viewport', { width, height });
    }

    function schedulePosition() {
      if (destroyed || positionFrame) return;
      positionFrame = globalScope.requestAnimationFrame(() => {
        positionFrame = 0;
        if (destroyed) return;
        positionFloatingHost();
      });
    }

    function applyLayout(payload) {
      layout = { state: payload.state, width: payload.width, height: payload.height };
      positionFloatingHost();
    }

    function moveShell(payload) {
      const bounds = panelViewportBounds(globalScope.innerWidth, globalScope.innerHeight);
      const rect = shellRect();
      if (payload.phase === 'start') return;
      if (payload.phase === 'move') {
        const left = clamp(
          rect.left + payload.deltaX,
          bounds.marginX,
          globalScope.innerWidth - rect.width - bounds.marginX
        );
        const top = clamp(
          rect.top + payload.deltaY,
          bounds.marginY,
          globalScope.innerHeight - rect.height - bounds.marginY
        );
        applyCanonicalHostGeometry({
          left,
          top,
          width: rect.width,
          height: rect.height
        });
        return;
      }
      announcePosition();
    }

    function restorePosition(payload) {
      manualBubblePosition = { x: payload.x, y: payload.y };
      schedulePosition();
    }

    function resetPosition() {
      manualBubblePosition = null;
      schedulePosition();
      sendMessage({ action: 'saveFloatingPosition', position: null }).catch(() => {});
    }

    function nearlyEqual(first, second) {
      return Number.isFinite(first) && Number.isFinite(second) && Math.abs(first - second) <= 1;
    }

    function hasCanonicalInlineStyles() {
      for (const [name, expected] of canonicalInlineValues) {
        if (
          host.style.getPropertyValue(name) !== expected.value ||
          host.style.getPropertyPriority(name) !== expected.priority
        ) {
          return false;
        }
      }
      return true;
    }

    function computedSurfaceIsVisible(element, { hostElement = false } = {}) {
      const computed = globalScope.getComputedStyle(element);
      if (
        computed.display === 'none' ||
        computed.visibility !== 'visible' ||
        Number.parseFloat(computed.opacity) !== 1 ||
        computed.pointerEvents === 'none' ||
        computed.filter !== 'none'
      ) {
        return false;
      }
      if (
        hostElement &&
        (computed.position !== 'fixed' ||
          computed.zIndex !== HOST_STATIC_STYLES.zIndex ||
          computed.transform !== 'none' ||
          computed.clipPath !== 'none')
      ) {
        return false;
      }
      return true;
    }

    function activationKey(activation) {
      return `${activation.occurredAt}:${activation.clientX}:${activation.clientY}`;
    }

    function verifySensitiveActivation(activation) {
      const now = Date.now();
      const age = now - activation.occurredAt;
      if (
        destroyed ||
        !expectedVisible ||
        host.isConnected === false ||
        document.visibilityState === 'hidden' ||
        age > ACTIVATION_MAX_AGE_MS ||
        age < -ACTIVATION_FUTURE_SKEW_MS ||
        activation.occurredAt <= lastTamperAt ||
        host.id !== '' ||
        !hasCanonicalInlineStyles()
      ) {
        return false;
      }

      const attributes = host.getAttributeNames?.() || ['style'];
      if (attributes.some((attribute) => attribute !== 'style')) return false;
      if (!computedSurfaceIsVisible(host, { hostElement: true })) return false;
      if (
        typeof host.checkVisibility === 'function' &&
        !host.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
      ) {
        return false;
      }
      for (let ancestor = host.parentElement; ancestor; ancestor = ancestor.parentElement) {
        if (!computedSurfaceIsVisible(ancestor)) return false;
      }

      const hostRect = host.getBoundingClientRect();
      const frameRect = frame.getBoundingClientRect();
      const rectMatches =
        nearlyEqual(hostRect.left, expectedRect.left) &&
        nearlyEqual(hostRect.top, expectedRect.top) &&
        nearlyEqual(hostRect.width, expectedRect.width) &&
        nearlyEqual(hostRect.height, expectedRect.height) &&
        nearlyEqual(frameRect.left, hostRect.left) &&
        nearlyEqual(frameRect.top, hostRect.top) &&
        nearlyEqual(frameRect.width, hostRect.width) &&
        nearlyEqual(frameRect.height, hostRect.height);
      if (
        !rectMatches ||
        hostRect.width <= 0 ||
        hostRect.height <= 0 ||
        hostRect.left < 0 ||
        hostRect.top < 0 ||
        hostRect.right > globalScope.innerWidth ||
        hostRect.bottom > globalScope.innerHeight ||
        activation.clientX > frameRect.width ||
        activation.clientY > frameRect.height
      ) {
        return false;
      }

      const key = activationKey(activation);
      const absolutePoint = {
        x: frameRect.left + activation.clientX,
        y: frameRect.top + activation.clientY
      };
      const verified = verifiedActivations.get(key);
      if (
        verified &&
        (!nearlyEqual(verified.left, hostRect.left) ||
          !nearlyEqual(verified.top, hostRect.top) ||
          !nearlyEqual(verified.x, absolutePoint.x) ||
          !nearlyEqual(verified.y, absolutePoint.y))
      ) {
        return false;
      }
      if (document.elementFromPoint(absolutePoint.x, absolutePoint.y) !== host) return false;
      if (!verified) {
        verifiedActivations.set(key, {
          left: hostRect.left,
          top: hostRect.top,
          x: absolutePoint.x,
          y: absolutePoint.y
        });
        if (verifiedActivations.size > 64) {
          verifiedActivations.delete(verifiedActivations.keys().next().value);
        }
      }
      return true;
    }

    function sendBridgeResponse(request, ok, value) {
      if (!bridgePort) return;
      const base = {
        requestId: request.requestId,
        command: request.command,
        ok
      };
      let response = ok
        ? envelope(nonce, 'bridge-response', { ...base, result: value })
        : envelope(nonce, 'bridge-response', {
            ...base,
            error: boundedError(value, 'The page bridge could not complete that action.')
          });
      if (ok && !validateBridgeToFrame(response, nonce, request.command)) {
        response = envelope(nonce, 'bridge-response', {
          ...base,
          ok: false,
          error: 'Alpha rejected an invalid bridge response.'
        });
      }
      bridgePort.postMessage(response);
    }

    async function handleBridgeRequest(request) {
      if (processedRequestIds.has(request.requestId)) return;
      processedRequestIds.add(request.requestId);
      if (processedRequestIds.size > 256) {
        const oldest = processedRequestIds.values().next().value;
        processedRequestIds.delete(oldest);
      }

      try {
        if (
          new Set([
            'collect-input',
            'collect-context',
            'set-composer',
            'enhance-prompt',
            'save-consent'
          ]).has(request.command) &&
          !verifySensitiveActivation(request.activation)
        ) {
          throw new Error('Alpha blocked an unverified page interaction. Try again.');
        }
        if (request.command === 'collect-input') {
          const composer = findComposer(adapter);
          if (!composer) throw new Error('Chat input is unavailable.');
          const rawText = composerValue(composer);
          if (rawText.length > MAX_PROMPT_CHARACTERS) {
            throw new Error('This prompt is too large to refine safely.');
          }
          const context = request.payload.includeContext
            ? collectConversationContext(adapter).slice(-MAX_CONTEXT_CHARACTERS)
            : '';
          sendBridgeResponse(request, true, {
            rawText,
            context,
            platform: adapter.id,
            displayName: adapter.displayName
          });
          return;
        }

        if (request.command === 'collect-context') {
          sendBridgeResponse(request, true, {
            context: collectConversationContext(adapter).slice(-MAX_CONTEXT_CHARACTERS)
          });
          return;
        }

        if (request.command === 'set-composer') {
          const composer = findComposer(adapter);
          if (!composer) throw new Error('Chat input is unavailable.');
          setComposerValue(composer, request.payload.text);
          composer.focus({ preventScroll: true });
          sendBridgeResponse(request, true, {});
          return;
        }

        if (request.command === 'enhance-prompt') {
          const response = await sendMessage({
            action: 'enhancePrompt',
            requestId: request.requestId,
            text: request.payload.text,
            platform: request.payload.platform,
            conversationContext: request.payload.conversationContext,
            preferences: { bypassCache: request.payload.bypassCache }
          });
          sendBridgeResponse(request, true, { response });
          return;
        }

        if (request.command === 'cancel-enhancement') {
          const response = await sendMessage({
            action: 'cancelEnhancement',
            requestId: request.payload.targetRequestId
          });
          if (!response?.success || typeof response.cancelled !== 'boolean') {
            throw new Error('Alpha could not cancel that request.');
          }
          sendBridgeResponse(request, true, { cancelled: response.cancelled });
          return;
        }

        if (request.command === 'get-settings') {
          const response = await sendMessage({ action: 'getFloatingUiState' });
          if (!response?.success || !response.state) {
            throw new Error(response?.error || 'Alpha could not load its controls.');
          }
          sendBridgeResponse(request, true, response.state);
          return;
        }

        if (request.command === 'save-consent') {
          const response = await sendMessage({
            action: 'saveFloatingConsent',
            prompt: request.payload.prompt,
            context: request.payload.context,
            acceptedAt: request.payload.acceptedAt
          });
          if (!response?.success) {
            throw new Error(response?.error || 'Alpha could not save your choice.');
          }
          sendBridgeResponse(request, true, {});
        }
      } catch (error) {
        sendBridgeResponse(request, false, error);
      }
    }

    function onPortMessage(event) {
      if (destroyed) return;
      if (!isAuthenticatedPortEvent(event, bridgePort, nonce, validateFrameToBridge)) {
        return;
      }
      const message = event.data;
      if (message.type === 'channel-ack') {
        if (channelEstablished) return;
        channelEstablished = true;
        postBridgeEvent('channel-ready', {
          platform: adapter.id,
          displayName: adapter.displayName,
          width: Math.max(1, Math.min(16_384, Math.floor(globalScope.innerWidth))),
          height: Math.max(1, Math.min(16_384, Math.floor(globalScope.innerHeight)))
        });
        sendMessage({ action: 'getFloatingUiState' })
          .then((response) => {
            const candidate = envelope(nonce, 'bridge-response', {
              requestId: '00000000-0000-4000-8000-000000000000',
              command: 'get-settings',
              ok: true,
              result: response?.state
            });
            if (
              response?.success &&
              validateBridgeToFrame(candidate, nonce, 'get-settings') &&
              response.state.floatingPosition
            ) {
              restorePosition(response.state.floatingPosition);
            }
          })
          .catch(() => {});
        return;
      }
      if (!channelEstablished) return;
      if (message.type === 'bridge-request') {
        handleBridgeRequest(message);
        return;
      }
      if (message.command === 'layout') applyLayout(message.payload);
      else if (message.command === 'move') moveShell(message.payload);
      else if (message.command === 'restore-position') restorePosition(message.payload);
      else if (message.command === 'reset-position') resetPosition();
    }

    function onFrameLoad(event) {
      if (destroyed || channelEstablished || event.isTrusted !== true || event.target !== frame) {
        return;
      }
      closeBridgePort();
      const channel = new globalScope.MessageChannel();
      bridgePort = channel.port1;
      bridgePort.addEventListener('message', onPortMessage);
      bridgePort.start();
      frame.contentWindow.postMessage(envelope(nonce, 'channel-init'), trustedExtensionOrigin, [
        channel.port2
      ]);
    }

    function closeBridgePort() {
      if (!bridgePort) return;
      bridgePort.removeEventListener?.('message', onPortMessage);
      bridgePort.close();
      bridgePort = null;
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      channelEstablished = false;
      if (positionFrame && typeof globalScope.cancelAnimationFrame === 'function') {
        globalScope.cancelAnimationFrame(positionFrame);
      }
      positionFrame = 0;
      inputResizeObserver?.disconnect();
      hostAttributeObserver?.disconnect();
      observedInput = null;
      closeBridgePort();
      frame.removeEventListener('load', onFrameLoad);
      globalScope.removeEventListener('resize', schedulePosition);
      globalScope.removeEventListener('scroll', schedulePosition, true);
      processedRequestIds.clear();
      verifiedActivations.clear();
      host._alphaReposition = null;
      host.remove();
    }

    globalScope.addEventListener('resize', schedulePosition, { passive: true });
    globalScope.addEventListener('scroll', schedulePosition, { passive: true, capture: true });
    positionFloatingHost();
    host._alphaReposition = schedulePosition;

    return Object.freeze({ destroy, host, reposition: schedulePosition });
  }

  globalScope.AlphaFloatingUi = Object.freeze({ create, panelViewportBounds });
})(globalThis);
