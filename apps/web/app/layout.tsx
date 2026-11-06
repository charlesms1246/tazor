import type { ReactNode } from 'react';
import '@fontsource-variable/onest/wght.css';
import '@fontsource-variable/jetbrains-mono/wght.css';
import '@fontsource/tektur/latin-600.css';
import './globals.css';
import { AppShell } from './_shell/shell.tsx';
import { Footer } from './footer.tsx';

export const metadata = {
  title: 'Tazor',
  description: 'B2B invoices, payment runs and direct debits in USDT on Whitechain.',
};
export const viewport = { width: 'device-width', initialScale: 1, themeColor: '#07081e' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AppShell>
          {children}
          <Footer />
        </AppShell>
      </body>
    </html>
  );
}
