'use client';

import { useEffect } from 'react';

const TARGET = '/docs/passkey-check/';

export default function DevelopersRedirect() {
  useEffect(() => { location.replace(TARGET); }, []);
  return (
    <div className="page">
      <p className="muted">The developer tools moved to the docs. <a href={TARGET}>Open the passkey check</a>.</p>
    </div>
  );
}
