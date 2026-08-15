import Link from 'next/link';
import { Brand } from './SiteHeader';

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="footer-main">
        <div>
          <Brand />
          <p>Better prompts. Clearer work. Fewer detours.</p>
        </div>
        <div className="footer-links">
          <div>
            <strong>Product</strong>
            <Link href="/">Overview</Link>
            <Link href="/account">Account</Link>
            <Link href="/support">Support</Link>
          </div>
          <div>
            <strong>Trust</strong>
            <Link href="/privacy">Privacy</Link>
            <Link href="/security">Security</Link>
            <Link href="/terms">Terms</Link>
          </div>
        </div>
      </div>
      <div className="footer-base">
        <span>© 2026 Alpha</span>
        <span>Designed for deliberate prompting.</span>
      </div>
    </footer>
  );
}
