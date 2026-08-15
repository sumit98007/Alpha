(function initializeAlphaContentObserver(globalScope) {
  'use strict';

  const ELEMENT_NODE = 1;

  function containsElement(node, element) {
    return node === element || Boolean(node?.contains?.(element));
  }

  function mutationBatchImpact(mutations, host) {
    if (!Array.isArray(mutations) && typeof mutations?.[Symbol.iterator] !== 'function') {
      return 'none';
    }
    let layoutChanged = false;
    for (const mutation of mutations) {
      // Streaming providers update text nodes constantly. Character data cannot add,
      // remove, or replace the composer/extension shell and is intentionally ignored.
      if (mutation?.type === 'characterData') continue;
      if (mutation?.type !== 'childList') continue;

      for (const node of mutation.removedNodes || []) {
        if (host && containsElement(node, host)) return 'host-removed';
        if (node?.nodeType === ELEMENT_NODE) layoutChanged = true;
      }
      for (const node of mutation.addedNodes || []) {
        if (host && containsElement(node, host)) continue;
        if (node?.nodeType === ELEMENT_NODE) layoutChanged = true;
      }
    }
    return layoutChanged ? 'layout' : 'none';
  }

  function mutationBatchNeedsCheck(mutations, host) {
    return mutationBatchImpact(mutations, host) !== 'none';
  }

  function createCoalescedScheduler(callback, options = {}) {
    const requestFrame =
      options.requestFrame || globalScope.requestAnimationFrame.bind(globalScope);
    const setTimer = options.setTimer || globalScope.setTimeout.bind(globalScope);
    const clearTimer = options.clearTimer || globalScope.clearTimeout.bind(globalScope);
    const now = options.now || (() => Date.now());
    const minimumIntervalMs = options.minimumIntervalMs || 500;
    let pendingFrame = 0;
    let pendingTimer = 0;
    let lastRunAt = Number.NEGATIVE_INFINITY;

    function run() {
      pendingFrame = 0;
      pendingTimer = 0;
      lastRunAt = now();
      callback();
    }

    function schedule(immediate = false) {
      if (pendingFrame) return;
      if (immediate && pendingTimer) {
        clearTimer(pendingTimer);
        pendingTimer = 0;
      }
      if (pendingTimer) return;
      if (immediate) {
        pendingFrame = requestFrame(run);
        return;
      }
      const remaining = Math.max(0, minimumIntervalMs - (now() - lastRunAt));
      if (remaining > 0) {
        pendingTimer = setTimer(() => {
          pendingTimer = 0;
          pendingFrame = requestFrame(run);
        }, remaining);
      } else {
        pendingFrame = requestFrame(run);
      }
    }

    function cancel() {
      if (pendingTimer) clearTimer(pendingTimer);
      pendingTimer = 0;
      pendingFrame = 0;
    }

    return Object.freeze({ cancel, schedule });
  }

  globalScope.AlphaContentObserver = Object.freeze({
    createCoalescedScheduler,
    mutationBatchImpact,
    mutationBatchNeedsCheck
  });
})(globalThis);
