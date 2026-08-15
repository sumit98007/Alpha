(function bootstrapAlphaContent(globalScope) {
  'use strict';

  const { createCoalescedScheduler, mutationBatchImpact } = globalScope.AlphaContentObserver;
  let activeInstance = null;
  let activeHost = null;

  function destroyActiveInterface() {
    activeInstance?.destroy();
    activeInstance = null;
    activeHost = null;
  }

  function ensureInterface() {
    if (activeInstance && activeInstance.host.isConnected === false) {
      destroyActiveInterface();
    }
    if (!activeInstance) {
      activeInstance = globalScope.AlphaFloatingUi.create(globalScope.AlphaPlatforms.current());
    }
    activeHost = activeInstance?.host || null;
    activeInstance?.reposition();
  }

  const interfaceScheduler = createCoalescedScheduler(ensureInterface);
  const scheduleInterfaceCheck = interfaceScheduler.schedule;

  const observer = new MutationObserver((mutations) => {
    const impact = mutationBatchImpact(mutations, activeHost);
    if (impact === 'host-removed') {
      destroyActiveInterface();
      interfaceScheduler.schedule(true);
    } else if (impact === 'layout') scheduleInterfaceCheck();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scheduleInterfaceCheck, { once: true });
  } else {
    scheduleInterfaceCheck();
  }
})(globalThis);
