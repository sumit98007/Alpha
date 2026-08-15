import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Privacy',
  description: 'How Alpha handles prompts, chat context, sensitive values, and account data.'
};

export default function PrivacyPage() {
  return (
    <main id="main-content" className="document-page">
      <header className="document-hero">
        <p className="section-kicker">Trust, explained plainly</p>
        <h1>Privacy is part of the prompt pipeline.</h1>
        <p>Last updated 11 August 2026</p>
      </header>

      <div className="document-layout">
        <aside aria-label="On this page">
          <strong>On this page</strong>
          <a href="#summary">Summary</a>
          <a href="#data">Data Alpha handles</a>
          <a href="#flow">How processing works</a>
          <a href="#retention">Storage and retention</a>
          <a href="#limited-use">Chrome Limited Use</a>
          <a href="#choices">Your choices</a>
        </aside>
        <article className="prose">
          <section id="summary">
            <span className="document-number">01</span>
            <h2>The short version</h2>
            <p>
              Alpha is designed to minimize what leaves your browser. When local protection is
              enabled and a supported pattern is detected, the value is replaced before an approved
              refinement request is sent. Detection can miss sensitive data. Chat history is
              excluded unless you turn on current-chat context.
            </p>
            <p>
              On first use, Alpha asks before it reads or transmits composer text. Current-chat
              context has a separate confirmation before Alpha reads recent visible messages. After
              you save those choices, each later bubble click is the explicit action that reads and
              sends that request until you reset your privacy choices.
            </p>
            <div className="callout">
              <strong>Alpha never needs your AI provider API key in the browser extension.</strong>
              <span>Provider credentials stay on the server-side gateway.</span>
            </div>
          </section>

          <section id="data">
            <span className="document-number">02</span>
            <h2>Data Alpha handles</h2>
            <h3>When you refine a prompt</h3>
            <ul>
              <li>
                The draft currently in the active composer, after enabled local protections run.
              </li>
              <li>Recent conversation text only when you explicitly enable “Use current chat.”</li>
              <li>
                Your selected task type, detail level, refinement preferences, optional custom
                guidance, and supported-site identifier: ChatGPT, Claude, or Gemini.
              </li>
              <li>
                Opaque per-request placeholders used to restore protected values only into the final
                prompt on your device.
              </li>
              <li>
                Placeholder-integrity metadata sent to Alpha’s gateway for validation: the source
                field, request identifier, and occurrence count. When local protection is enabled
                and detection succeeds, the locally detected value, detection category, and
                placeholder-to-value map do not leave the extension.
              </li>
            </ul>
            <h3>When you use an account</h3>
            <p>
              The hosted account surface may receive your email address and, when available, display
              name from Sign in with ChatGPT. Alpha does not receive your ChatGPT password. The
              hosting platform and authentication provider also process session cookies, connection
              data, and sign-in metadata under their terms; their final processor and retention
              disclosures must be approved before this preview becomes public.
            </p>
            <h3>Operational data</h3>
            <p>
              The gateway processes request timing, source IP, and the authenticated account subject
              identifier to authenticate requests and enforce abuse limits and daily quotas.
              Production disables default raw-IP Fastify request logs. Redis stores only
              secret-keyed HMAC identifiers and counters: rate-window entries expire after 60
              seconds, and quota entries expire within 24 hours. Alpha’s gateway application logs
              must not include source IP, prompt text, chat content, authorization headers, or
              provider credentials. Infrastructure providers may process connection metadata under
              their separately approved retention terms, which must be finalized before publication.
            </p>
          </section>

          <section id="flow">
            <span className="document-number">03</span>
            <h2>How a refinement moves</h2>
            <ol>
              <li>
                <strong>On your device:</strong> when protection is enabled and detection succeeds,
                Alpha replaces supported sensitive patterns with request-specific placeholders.
              </li>
              <li>
                <strong>With your action:</strong> the resulting prompt, the supported-site
                identifier, and the preferences you chose travel over HTTPS to Alpha’s gateway.
              </li>
              <li>
                <strong>At the gateway:</strong> the request is authenticated, size-limited,
                schema-validated, rate-limited, and sent to the configured AI model. The gateway
                validates any placeholder metadata; Gemini receives the resulting text and
                refinement instructions, not values successfully detected and replaced locally or
                their restoration map.
              </li>
              <li>
                <strong>Back on your device:</strong> Alpha validates the response and restores only
                prompt-origin placeholders. Values detected in context or guidance are not restored;
                unprotected or undetected text can be reproduced in the result.
              </li>
            </ol>
            <p>
              Alpha currently uses Google’s Gemini API to generate refinements. Google processes the
              resulting request as Alpha’s service provider under the applicable API terms.
            </p>
            <p>
              When enabled and successful, Alpha’s local redaction protects the
              Alpha-to-gateway-to-Gemini refinement path. You type on a page controlled by ChatGPT,
              Claude, or Gemini, so that host service may process composer drafts and inserted
              results under its own terms, including before you press its submit button.
            </p>
          </section>

          <section id="retention">
            <span className="document-number">04</span>
            <h2>Storage and retention</h2>
            <p>
              After a successful refinement, the base prompt and matching refined result stay only
              in the current page’s extension-frame memory so the bubble can reopen the result and
              “Try again” can use the same base. The matching cache key is a SHA-256 fingerprint and
              does not contain raw prompt or recent-chat text. The base and result are not written
              to persistent Chrome storage. A failed or cancelled refinement clears the retry base;
              reloading or closing the tab clears all of this page memory. Changing the base prompt
              or choosing “Try again” creates a new refinement. Preferences, consent state, bubble
              position, custom guidance, and aggregate local counters remain in Chrome’s local
              extension storage until overwritten, cleared with “Clear saved data,” or removed with
              the extension. Custom guidance is stored without at-rest redaction, so do not save
              secrets there. Clearing saved data does not sign you out; Sign out separately removes
              the in-memory session token.
            </p>
            <p>
              Server-side semantic similarity caching is rejected in production, so a changed prompt
              is not answered with a merely similar stored result. Alpha does not intentionally
              persist raw prompt or chat content in application logs.
            </p>
          </section>

          <section id="limited-use">
            <span className="document-number">05</span>
            <h2>Chrome Web Store Limited Use</h2>
            <p>
              Alpha’s use of information received from Google APIs adheres to the{' '}
              <a href="https://developer.chrome.com/docs/webstore/program-policies/limited-use">
                Chrome Web Store User Data Policy
              </a>
              , including the Limited Use requirements.
            </p>
            <ul>
              <li>
                Alpha uses prompt and optional recent-chat data only to provide its disclosed single
                purpose: refining the prompt you choose.
              </li>
              <li>
                Alpha transfers that data only to its gateway and configured Gemini processor when
                necessary to provide the refinement, or where required for security or law.
              </li>
              <li>
                Alpha does not sell user data or use it for advertising, lending, or
                credit-worthiness.
              </li>
              <li>
                Humans do not routinely read prompt or chat data. Human access is allowed only with
                specific consent, for security or abuse investigation, or where legally required.
              </li>
            </ul>
          </section>

          <section id="choices">
            <span className="document-number">06</span>
            <h2>Your controls</h2>
            <ul>
              <li>Keep current-chat context off; it is off by default.</li>
              <li>Review your prompt and local-protection choice before starting a refinement.</li>
              <li>
                Reset sharing choices or clear persistent local extension data from the Alpha menu.
                Removing the extension also clears its local extension storage.
              </li>
              <li>Do not submit data you are not authorized to share with an AI service.</li>
            </ul>
            <p>
              General product questions can be opened through the project’s{' '}
              <a href="https://github.com/sumit98007/Alpha/issues">support channel</a>. Please do
              not include secrets, private prompt content, identity documents, or deletion requests
              in a public issue. A private, identity-verifying data-request channel must be
              published before the account preview or extension is released publicly.
            </p>
          </section>

          <nav className="document-next" aria-label="Related policies">
            <Link href="/security">
              <span>Next</span>Security practices →
            </Link>
            <Link href="/terms">
              <span>Also</span>Terms of use →
            </Link>
          </nav>
        </article>
      </div>
    </main>
  );
}
