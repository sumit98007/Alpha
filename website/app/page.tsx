import type { Metadata } from 'next';
import Link from 'next/link';
import { ProductDemo } from './components/ProductDemo';

export const metadata: Metadata = {
  title: 'Better prompts, right where you type',
  description:
    'Shape rough ideas into professional prompts without leaving ChatGPT, Claude, or Gemini.'
};

export default function Home() {
  return (
    <main id="main-content">
      <section className="hero section-shell">
        <div className="hero-copy">
          <p className="eyebrow">
            <span /> Prompt intelligence, where you type
          </p>
          <h1>
            Think rough.
            <br />
            <em>Ask sharp.</em>
          </h1>
          <p className="hero-lede">
            Alpha turns an unfinished thought into a clear, purposeful prompt—without pulling you
            out of the conversation.
          </p>
          <div className="hero-actions">
            <Link className="button button-primary" href="/account">
              Preview hosted account <span aria-hidden="true">↗</span>
            </Link>
            <Link className="text-link" href="/privacy">
              Read the privacy promise <span aria-hidden="true">→</span>
            </Link>
          </div>
          <ul className="trust-list" aria-label="Product principles">
            <li>Local redaction</li>
            <li>Context is opt-in</li>
            <li>No provider keys in the extension</li>
          </ul>
        </div>
        <ProductDemo />
      </section>

      <section className="statement section-shell" aria-labelledby="statement-title">
        <p className="section-kicker">One small layer. A much better request.</p>
        <h2 id="statement-title">
          Your words stay yours.
          <br />
          Alpha gives them <span>direction.</span>
        </h2>
      </section>

      <section className="steps section-shell" aria-labelledby="steps-title">
        <div className="section-heading">
          <p className="section-kicker">How it works</p>
          <h2 id="steps-title">From thought to useful prompt in three moves.</h2>
        </div>
        <ol className="step-grid">
          <li>
            <span className="step-number">01</span>
            <h3>Write naturally</h3>
            <p>
              Start with the question you already have. No templates, prompt syntax, or tab
              switching.
            </p>
          </li>
          <li>
            <span className="step-number">02</span>
            <h3>Let Alpha shape it</h3>
            <p>
              The floating bubble reads only what you approve and, when enabled, locally replaces
              supported sensitive-value patterns it detects before clarifying intent.
            </p>
          </li>
          <li>
            <span className="step-number">03</span>
            <h3>Review, retry, use</h3>
            <p>
              Edit the result, ask for another pass, or place it back into the active composer in
              one click.
            </p>
          </li>
        </ol>
      </section>

      <section className="feature-band" aria-labelledby="features-title">
        <div className="section-shell feature-layout">
          <div>
            <p className="section-kicker section-kicker-light">Built to stay out of the way</p>
            <h2 id="features-title">A quiet tool with serious boundaries.</h2>
          </div>
          <div className="feature-list">
            <article>
              <span>01</span>
              <div>
                <h3>Moves with your workspace</h3>
                <p>
                  Drag the bubble anywhere. The panel transforms from it, stays inside the active
                  browser viewport, and returns to the same anchor.
                </p>
              </div>
            </article>
            <article>
              <span>02</span>
              <div>
                <h3>Remembers the useful result</h3>
                <p>
                  Collapse and reopen without losing the refinement. Change the base prompt and
                  Alpha knows it is time for a fresh pass.
                </p>
              </div>
            </article>
            <article>
              <span>03</span>
              <div>
                <h3>Protects before sending</h3>
                <p>
                  When protection is enabled and detection succeeds, supported API keys,
                  credentialed database URLs, payment-card numbers, and selected identifiers are
                  replaced on-device before an approved request reaches the gateway.
                </p>
              </div>
            </article>
          </div>
        </div>
      </section>

      <section className="platforms section-shell" aria-labelledby="platforms-title">
        <div>
          <p className="section-kicker">Works where the conversation is</p>
          <h2 id="platforms-title">
            One Alpha.
            <br />
            Three leading AI workspaces.
          </h2>
        </div>
        <div className="platform-grid" aria-label="Supported platforms">
          <span>ChatGPT</span>
          <span>Claude</span>
          <span>Gemini</span>
        </div>
      </section>

      <section className="cta section-shell" aria-labelledby="cta-title">
        <div className="cta-mark" aria-hidden="true">
          ✦
        </div>
        <div>
          <p className="section-kicker section-kicker-light">Ready when your thought is</p>
          <h2 id="cta-title">Turn the next rough idea into your best request.</h2>
        </div>
        <Link className="button button-light" href="/account">
          View account preview <span aria-hidden="true">→</span>
        </Link>
      </section>
    </main>
  );
}
