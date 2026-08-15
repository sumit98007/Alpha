import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Security',
  description: "Alpha's security model, API guardrails, and responsible disclosure path."
};

const controls = [
  [
    'Browser boundary',
    'When protection is enabled and detection succeeds, supported values are represented by opaque, request-scoped placeholders in transit and restored locally after integrity checks.'
  ],
  [
    'Authenticated gateway',
    'The public architecture uses short-lived per-user bearer tokens. Shared extension keys are restricted to local or internal development.'
  ],
  [
    'Constrained requests',
    'Runtime schemas, body limits, origin checks, rate limits, provider timeouts, and bounded output reduce abuse and runaway cost.'
  ],
  [
    'Least privilege',
    'The production extension is limited to the supported AI sites and the configured HTTPS gateway. Broad optional host access is excluded.'
  ],
  [
    'Secret hygiene',
    'Provider credentials are server-only environment secrets and are never included in the extension bundle, website source, responses, or logs.'
  ],
  [
    'Fail closed',
    'Invalid authentication and unavailable dependencies produce explicit errors; malformed or corrupted provider output produces an explicit error or safe degraded state with the exact original prompt.'
  ]
];

export default function SecurityPage() {
  return (
    <main id="main-content">
      <section className="trust-hero section-shell">
        <p className="section-kicker">Security</p>
        <h1>
          Small surface.
          <br />
          <span>Strong boundaries.</span>
        </h1>
        <p>
          Alpha treats every prompt as private input and every browser client as untrusted. The
          gateway enforces the boundary.
        </p>
      </section>

      <section className="control-grid section-shell" aria-label="Security controls">
        {controls.map(([title, copy], index) => (
          <article key={title}>
            <span>{String(index + 1).padStart(2, '0')}</span>
            <h2>{title}</h2>
            <p>{copy}</p>
          </article>
        ))}
      </section>

      <section className="disclosure section-shell">
        <div>
          <p className="section-kicker section-kicker-light">Responsible disclosure</p>
          <h2>Found a security issue?</h2>
        </div>
        <div>
          <p>
            Report it privately through GitHub Security Advisories. Do not include real user data,
            credentials, or public exploit details.
          </p>
          <a
            className="button button-primary"
            href="https://github.com/sumit98007/Alpha/security/advisories/new"
          >
            Open a private report <span aria-hidden="true">↗</span>
          </a>
        </div>
      </section>

      <section className="small-cta section-shell">
        <h2>Want the data-flow detail?</h2>
        <Link className="text-link" href="/privacy">
          Read the privacy policy →
        </Link>
      </section>
    </main>
  );
}
