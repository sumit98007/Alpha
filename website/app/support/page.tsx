import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Support',
  description: 'Help with Alpha setup, privacy, and prompt refinement.'
};

const faqs = [
  [
    'Why does Alpha ask before using chat context?',
    'Conversation history can contain information unrelated to the draft. Alpha keeps it off by default and includes recent messages only after you opt in.'
  ],
  [
    'What happens when I close the bubble?',
    'The matching result remains available locally. Reopen the bubble to review it again; change the base prompt or select Try again to request another version.'
  ],
  [
    'Why is the gateway unavailable?',
    'Alpha fails closed when authentication, network access, rate limits, or the model provider are unavailable. Retry after checking your connection; the original composer text remains untouched.'
  ],
  [
    'Can Alpha send a prompt automatically?',
    'No. Alpha can place an approved refinement into the composer, but you decide whether to send it to the AI service.'
  ]
];

export default function SupportPage() {
  return (
    <main id="main-content">
      <section className="support-hero section-shell">
        <p className="section-kicker">Support</p>
        <h1>
          A clear answer,
          <br />
          <span>without the runaround.</span>
        </h1>
        <p>
          Start with the common questions below. For a reproducible product issue, open a GitHub
          report without private prompt content.
        </p>
        <a className="button button-primary" href="https://github.com/sumit98007/Alpha/issues/new">
          Open a support issue <span aria-hidden="true">↗</span>
        </a>
      </section>
      <section className="faq section-shell" aria-labelledby="faq-title">
        <div>
          <p className="section-kicker">Quick help</p>
          <h2 id="faq-title">Frequently asked</h2>
        </div>
        <div>
          {faqs.map(([question, answer]) => (
            <details key={question}>
              <summary>
                {question}
                <span aria-hidden="true">+</span>
              </summary>
              <p>{answer}</p>
            </details>
          ))}
        </div>
      </section>
      <section className="small-cta section-shell">
        <h2>Handling a security concern?</h2>
        <Link className="text-link" href="/security">
          Use private disclosure →
        </Link>
      </section>
    </main>
  );
}
