'use client';

import { useState } from 'react';

const refinedPrompt = `Act as a senior product strategist. Evaluate the onboarding flow for a privacy-first AI browser extension.

Return:
1. The three highest-friction moments
2. Why each one may cause abandonment
3. A specific improvement and measurable success signal

Prioritize changes that can be tested in one week. State any assumptions.`;

export function ProductDemo() {
  const [open, setOpen] = useState(true);
  const [version, setVersion] = useState(0);
  const [composerValue, setComposerValue] = useState(
    'review my onboarding and tell me what to fix'
  );
  const [status, setStatus] = useState('Tap the bubble to collapse and reopen');
  const output = `${refinedPrompt}${version % 2 ? '\n\nKeep the final answer under 500 words.' : ''}`;

  async function copyPrompt() {
    try {
      await navigator.clipboard.writeText(output);
      setStatus('Refined prompt copied');
    } catch {
      setStatus('Clipboard access is unavailable in this preview');
    }
  }

  function togglePanel() {
    setOpen((current) => {
      setStatus(
        current ? 'Alpha collapsed — tap to reopen' : 'Refinement restored from local state'
      );
      return !current;
    });
  }

  return (
    <div className={`product-demo ${open ? 'is-open' : 'is-closed'}`}>
      <div className="demo-browser-bar" aria-hidden="true">
        <i />
        <i />
        <i />
        <span>chatgpt.com</span>
      </div>
      <div className="demo-canvas">
        <p className="demo-question">What’s on your mind today?</p>
        <div className="demo-composer">
          <span>{composerValue}</span>
          <button aria-label="Send example prompt">↑</button>
        </div>
        <div className="demo-alpha">
          <button
            className="demo-bubble"
            type="button"
            aria-label={open ? 'Collapse Alpha preview' : 'Open Alpha preview'}
            aria-expanded={open}
            onClick={togglePanel}
          >
            <span aria-hidden="true">✦</span>
          </button>
          <section className="demo-panel" aria-hidden={!open}>
            <div className="demo-panel-header">
              <div>
                <small>Alpha refined</small>
                <strong>Review your professional prompt</strong>
              </div>
              <button type="button" onClick={() => setOpen(false)} aria-label="Collapse preview">
                −
              </button>
            </div>
            <pre>{output}</pre>
            <div className="demo-meta">
              <span>~92 prompt tokens</span>
              <span>Protected locally</span>
            </div>
            <div className="demo-actions">
              <button type="button" onClick={copyPrompt}>
                Copy
              </button>
              <button
                type="button"
                onClick={() => {
                  setVersion((current) => current + 1);
                  setStatus('A fresh refinement is ready');
                }}
              >
                Try again
              </button>
              <button
                type="button"
                className="demo-use"
                onClick={() => {
                  setComposerValue(
                    'Act as a senior product strategist. Evaluate my onboarding flow…'
                  );
                  setStatus('Refined prompt placed in the composer');
                  setOpen(false);
                }}
              >
                Use prompt
              </button>
            </div>
          </section>
        </div>
      </div>
      <p className="demo-caption" aria-live="polite">
        <span>Live interaction</span> {status}
      </p>
    </div>
  );
}
