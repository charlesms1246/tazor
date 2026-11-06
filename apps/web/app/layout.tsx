import type { ReactNode } from 'react';

export const metadata = { title: 'Tazor' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'ui-monospace, monospace', margin: '2rem' }}>{children}</body>
    </html>
  );
}
