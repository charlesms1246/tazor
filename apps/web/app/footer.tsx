'use client';

import { useEffect, useState } from 'react';

const BUILD = process.env.NEXT_PUBLIC_BUILD_TIME || 'unversioned';

export function Footer() {
  const [host, setHost] = useState('');
  useEffect(() => setHost(location.host), []);
  return (
    <footer className="footer">
      <nav data-testid="footer-links" className="row" style={{ gap: 16 }}>
        <a href="/policies/">Policies</a><a href="/financing/">Financing</a><a href="/settings/">Settings</a><a href="/docs/">Docs</a>
      </nav>
      <span>Running from <span data-testid="host" className="mono small">{host || '…'}</span></span>
      <span>Build <span data-testid="build" className="mono small">{BUILD}</span></span>
      <span>Testnet build · WB Soul is a labelled simulation</span>
    </footer>
  );
}
