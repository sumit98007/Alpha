(function initializeAlphaPlatforms(globalScope) {
  'use strict';

  const adapters = Object.freeze({
    chatgpt: {
      id: 'chatgpt',
      displayName: 'ChatGPT',
      hosts: ['chatgpt.com'],
      composerSelectors: [
        '#prompt-textarea',
        'form textarea[data-id="root"]',
        'form textarea',
        'main div[contenteditable="true"][data-virtualkeyboard="true"]'
      ],
      messageSelectors: ['[data-message-author-role]'],
      role(element) {
        return element.getAttribute('data-message-author-role') === 'user' ? 'User' : 'Assistant';
      }
    },
    claude: {
      id: 'claude',
      displayName: 'Claude',
      hosts: ['claude.ai'],
      composerSelectors: [
        'fieldset div[contenteditable="true"].ProseMirror',
        'form div[contenteditable="true"].ProseMirror',
        'div[contenteditable="true"].ProseMirror',
        'main div[contenteditable="true"]'
      ],
      messageSelectors: [
        '[data-testid="user-message"]',
        '[data-testid="assistant-message"]',
        '.font-claude-message'
      ],
      role(element) {
        const hint = `${element.getAttribute('data-testid') || ''} ${element.className || ''}`;
        return /user/i.test(hint) ? 'User' : 'Assistant';
      }
    },
    gemini: {
      id: 'gemini',
      displayName: 'Gemini',
      hosts: ['gemini.google.com'],
      composerSelectors: [
        'rich-textarea div[contenteditable="true"].ql-editor',
        'rich-textarea div[contenteditable="true"]',
        'div[contenteditable="true"].ql-editor',
        'main div[contenteditable="true"]'
      ],
      messageSelectors: ['user-query', 'model-response'],
      role(element) {
        return element.tagName.toLowerCase() === 'user-query' ? 'User' : 'Assistant';
      }
    },
    generic: {
      id: 'generic',
      displayName: 'this AI service',
      hosts: [],
      composerSelectors: ['textarea', 'div[contenteditable="true"]'],
      messageSelectors: [],
      role() {
        return 'Assistant';
      }
    }
  });

  function hostMatches(host, allowedHost) {
    return host === allowedHost;
  }

  function current() {
    const host = globalScope.location.hostname.toLowerCase();
    return (
      Object.values(adapters).find((adapter) =>
        adapter.hosts.some((allowed) => hostMatches(host, allowed))
      ) || adapters.generic
    );
  }

  function visibleElement(element) {
    if (!(element instanceof HTMLElement) || !element.isConnected) return false;
    if (element.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
    const rectangles = element.getClientRects();
    if (!rectangles.length) return false;
    const rectangle = element.getBoundingClientRect();
    if (rectangle.width <= 0 || rectangle.height <= 0) return false;
    if (
      typeof element.checkVisibility === 'function' &&
      !element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
    ) {
      return false;
    }
    const style = globalScope.getComputedStyle(element);
    const opacity = Number.parseFloat(style.opacity);
    return (
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      style.visibility !== 'collapse' &&
      (!Number.isFinite(opacity) || opacity > 0)
    );
  }

  function acceptableComposer(element) {
    if (!visibleElement(element)) return false;
    if (
      element.matches('[disabled], [aria-disabled="true"]') ||
      element.disabled === true ||
      element.readOnly === true
    ) {
      return false;
    }
    const editable =
      element.tagName === 'TEXTAREA' ||
      element.tagName === 'INPUT' ||
      element.isContentEditable === true ||
      element.getAttribute('contenteditable') === 'true' ||
      element.getAttribute('contenteditable') === 'plaintext-only';
    if (!editable || element.getAttribute('contenteditable') === 'false') return false;
    return true;
  }

  function findComposer(adapter = current()) {
    const candidates = [];
    const seen = new Set();
    for (const selector of adapter.composerSelectors) {
      for (const candidate of document.querySelectorAll(selector)) {
        if (!seen.has(candidate) && acceptableComposer(candidate)) {
          seen.add(candidate);
          candidates.push(candidate);
        }
      }
    }
    const active = document.activeElement;
    const focused = candidates.find(
      (candidate) => candidate === active || (active && candidate.contains(active))
    );
    if (focused) return focused;
    return (
      candidates.sort(
        (left, right) => right.getBoundingClientRect().bottom - left.getBoundingClientRect().bottom
      )[0] || null
    );
  }

  function composerValue(element) {
    if (!element) return '';
    if (element.tagName === 'TEXTAREA' || element.tagName === 'INPUT') return element.value || '';
    return element.innerText || element.textContent || '';
  }

  function dispatchInput(element, value) {
    let inputEvent;
    try {
      inputEvent = new InputEvent('input', {
        bubbles: true,
        composed: true,
        inputType: 'insertText',
        data: value
      });
    } catch (_error) {
      inputEvent = new Event('input', { bubbles: true, composed: true });
    }
    element.dispatchEvent(inputEvent);
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function setNativeValue(element, value) {
    const prototype =
      element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    if (setter) setter.call(element, value);
    else element.value = value;
    dispatchInput(element, value);
  }

  function setRichTextValue(element, value) {
    element.focus();
    element.replaceChildren(document.createTextNode(value));
    dispatchInput(element, value);

    const selection = globalScope.getSelection?.();
    if (selection) {
      const range = document.createRange();
      range.selectNodeContents(element);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
    }
  }

  function setComposerValue(element, value) {
    if (!acceptableComposer(element)) throw new Error('The chat input is unavailable.');
    if (element.tagName === 'TEXTAREA' || element.tagName === 'INPUT') {
      setNativeValue(element, value);
    } else {
      setRichTextValue(element, value);
    }
  }

  function messageElements(adapter) {
    const seenElements = new Set();
    const elements = [];
    for (const selector of adapter.messageSelectors) {
      for (const element of document.querySelectorAll(selector)) {
        if (!seenElements.has(element) && visibleElement(element)) {
          seenElements.add(element);
          elements.push(element);
        }
      }
    }
    return elements
      .filter(
        (element) => !elements.some((nested) => nested !== element && element.contains(nested))
      )
      .sort((left, right) => {
        if (left === right) return 0;
        return left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
      });
  }

  function collectConversationContext(adapter = current(), options = {}) {
    const maxMessages = options.maxMessages || 8;
    const maxCharacters = options.maxCharacters || 12_000;
    const composer = findComposer(adapter);
    const seenText = new Set();
    const messages = [];

    for (const element of messageElements(adapter)) {
      if (composer && (element === composer || element.contains(composer))) continue;
      const text = (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text || seenText.has(text)) continue;
      seenText.add(text);
      messages.push(`${adapter.role(element)}: ${text.slice(0, maxCharacters)}`);
    }

    return messages.slice(-maxMessages).join('\n\n').slice(-maxCharacters);
  }

  globalScope.AlphaPlatforms = Object.freeze({
    acceptableComposer,
    adapters,
    collectConversationContext,
    composerValue,
    current,
    findComposer,
    setComposerValue,
    visibleElement
  });
})(globalThis);
