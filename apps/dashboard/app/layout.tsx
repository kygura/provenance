import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Provenance',
  description: 'Trending tokens, traced back to where their meme came from.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh bg-plane text-ink antialiased">{children}</body>
    </html>
  );
}
