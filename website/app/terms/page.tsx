import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Terms', description: 'Terms governing use of Alpha.' };

export default function TermsPage() {
  return (
    <main id="main-content" className="document-page">
      <header className="document-hero">
        <p className="section-kicker">Terms of use</p>
        <h1>Use Alpha thoughtfully.</h1>
        <p>Last updated 9 August 2026</p>
      </header>
      <article className="prose prose-centered">
        <section>
          <span className="document-number">01</span>
          <h2>Agreement</h2>
          <p>
            These terms govern your use of the Alpha website, browser extension, and
            prompt-refinement service. By using Alpha, you agree to these terms and the{' '}
            <a href="/privacy">privacy policy</a>. If you do not agree, do not use the service.
          </p>
        </section>
        <section>
          <span className="document-number">02</span>
          <h2>What Alpha provides</h2>
          <p>
            Alpha helps rewrite user-supplied text into prompts for third-party AI services. Outputs
            may be incomplete, inaccurate, or unsuitable. You remain responsible for reviewing every
            refined prompt and any downstream AI response.
          </p>
        </section>
        <section>
          <span className="document-number">03</span>
          <h2>Acceptable use</h2>
          <p>
            You may not use Alpha to violate law, infringe rights, bypass access controls,
            distribute malware, probe the service without authorization, interfere with other users,
            or submit information you are not permitted to process. Automated abuse and attempts to
            extract credentials or system instructions are prohibited.
          </p>
        </section>
        <section>
          <span className="document-number">04</span>
          <h2>Your content</h2>
          <p>
            You retain rights in the text you submit. You give Alpha the limited permission needed
            to process that text and return a refinement. Do not submit regulated, confidential, or
            sensitive data unless you have assessed the applicable AI provider and are authorized to
            do so.
          </p>
        </section>
        <section>
          <span className="document-number">05</span>
          <h2>Accounts and availability</h2>
          <p>
            You are responsible for activity associated with your account and for keeping access
            methods secure. Alpha may rate-limit, suspend, or terminate access to protect users,
            comply with law, or respond to abuse. Features may change and uninterrupted availability
            is not guaranteed.
          </p>
        </section>
        <section>
          <span className="document-number">06</span>
          <h2>Third-party services</h2>
          <p>
            Alpha interoperates with services such as ChatGPT, Claude, Gemini, Chrome, and a
            configured AI model provider. Those services have their own terms and privacy practices.
            Alpha is not endorsed by or responsible for those third-party services.
          </p>
        </section>
        <section>
          <span className="document-number">07</span>
          <h2>Disclaimers and liability</h2>
          <p>
            To the extent permitted by law, Alpha is provided “as is” without implied warranties.
            Alpha is not professional legal, medical, financial, or security advice. Liability is
            limited to the maximum extent permitted by applicable law; rights that cannot legally be
            excluded remain unaffected.
          </p>
        </section>
        <section>
          <span className="document-number">08</span>
          <h2>Changes and contact</h2>
          <p>
            Material changes will be reflected by updating the date above. Questions can be raised
            through the project’s{' '}
            <a href="https://github.com/sumit98007/Alpha/issues">support channel</a>. These terms
            should be reviewed by qualified counsel before a paid or broadly distributed launch.
          </p>
        </section>
      </article>
    </main>
  );
}
