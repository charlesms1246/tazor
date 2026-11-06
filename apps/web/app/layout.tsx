import type { ReactNode } from 'react';
import { Footer } from './footer.tsx';

export const metadata = { title: 'Tazor' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'ui-monospace, monospace', margin: '2rem' }}>{children}<Footer /></body>
    </html>
  );
}
