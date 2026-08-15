import type { Metadata } from 'next';
import Link from 'next/link';
import { chatGPTSignInPath, chatGPTSignOutPath, getChatGPTUser } from '../chatgpt-auth';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: 'Hosted account preview',
  description: 'Preview Alpha’s hosted identity surface before extension pairing is released.'
};

export default async function AccountPage() {
  const user = await getChatGPTUser();

  return (
    <main id="main-content" className="account-page section-shell">
      <section className="account-intro">
        <p className="section-kicker">Hosted account preview</p>
        <h1>
          {user ? (
            <>
              Good to see you,
              <br />
              <span>{user.displayName}.</span>
            </>
          ) : (
            <>
              One identity.
              <br />
              <span>A safer gateway.</span>
            </>
          )}
        </h1>
        <p>
          {user
            ? 'Your hosted preview session is active. It does not sign the extension in; pairing and cross-device preferences will appear only after the production identity broker is reviewed and connected.'
            : 'Sign in with ChatGPT only to preview Alpha’s hosted identity surface. This does not sign the extension in, and your password is never shared with Alpha.'}
        </p>
      </section>
      <section className="account-card">
        <div className="account-card-mark" aria-hidden="true">
          ✦
        </div>
        {user ? (
          <>
            <p className="account-label">Signed in as</p>
            <h2>{user.fullName ?? 'Alpha user'}</h2>
            <p>{user.email}</p>
            <div className="account-status">
              <span /> Identity verified
            </div>
            <a className="button button-secondary" href={chatGPTSignOutPath('/account')}>
              Sign out
            </a>
          </>
        ) : (
          <>
            <p className="account-label">Secure sign-in</p>
            <h2>Continue with ChatGPT</h2>
            <p>
              The hosting platform handles the OAuth flow and sends Alpha only your verified
              identity headers.
            </p>
            <a className="button button-primary" href={chatGPTSignInPath('/account')}>
              Sign in with ChatGPT <span aria-hidden="true">↗</span>
            </a>
          </>
        )}
        <p className="account-footnote">
          By continuing, you agree to Alpha’s <Link href="/terms">terms</Link> and acknowledge the{' '}
          <Link href="/privacy">privacy policy</Link>.
        </p>
      </section>
    </main>
  );
}
