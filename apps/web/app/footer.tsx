'use client';

import { useEffect, useState } from 'react';

const BUILD = process.env.NEXT_PUBLIC_BUILD_TIME || 'unversioned';

export function Footer() {
  const [host, setHost] = useState('');
  useEffect(() => setHost(location.host), []);
  return (
    <footer style={{ marginTop: '3rem', fontSize: '0.8em', color: '#666' }}>
      <nav data-testid="footer-links"><a href="/policies/">Policies</a> · <a href="/financing/">Financing</a> · <a href="/settings/">Settings</a></nav>
      Running from: <span data-testid="host">{host || '…'}</span> · build <span data-testid="build">{BUILD}</span>
    </footer>
  );
}
