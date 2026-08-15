import Link from 'next/link';

export function Brand() {
  return (
    <Link className="brand" href="/" aria-label="Alpha home">
      <span className="brand-symbol" aria-hidden="true">
        ✦
      </span>
      <span className="brand-name">Alpha</span>
    </Link>
  );
}

export function SiteHeader() {
  return (
    <header className="site-header">
      <div className="header-inner">
        <Brand />
        <nav aria-label="Primary navigation">
          <Link href="/privacy">Privacy</Link>
          <Link href="/security">Security</Link>
          <Link href="/support">Support</Link>
        </nav>
        <Link className="header-account" href="/account">
          Account preview <span aria-hidden="true">↗</span>
        </Link>
      </div>
    </header>
  );
}
