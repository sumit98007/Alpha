import type { Metadata } from 'next';
import './globals.css';
import { SiteFooter } from './components/SiteFooter';
import { SiteHeader } from './components/SiteHeader';

export const metadata: Metadata = {
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_SITE_URL ?? 'https://alpha-prompt-optimizer.sumit-512.chatgpt.site'
  ),
  title: {
    default: 'Alpha — Better prompts, right where you type',
    template: '%s | Alpha'
  },
  description:
    'Alpha turns rough ideas into clear, useful prompts inside ChatGPT, Claude, and Gemini with optional local protection for supported sensitive-value patterns.',
  icons: {
    icon: '/favicon.svg',
    shortcut: '/favicon.svg'
  },
  openGraph: {
    title: 'Alpha — Better prompts, right where you type',
    description: 'A privacy-first prompt optimizer that lives beside your AI composer.',
    type: 'website',
    images: [{ url: '/og.png', width: 1200, height: 630, alt: 'Alpha prompt optimizer' }]
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Alpha — Better prompts, right where you type',
    description: 'A privacy-first prompt optimizer that lives beside your AI composer.',
    images: ['/og.png']
  }
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        <a className="skip-link" href="#main-content">
          Skip to content
        </a>
        <SiteHeader />
        {children}
        <SiteFooter />
      </body>
    </html>
  );
}
