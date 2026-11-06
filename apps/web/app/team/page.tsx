'use client';

import { useEffect } from 'react';

const TARGET = '/company/';

export default function TeamRedirect() {
  useEffect(() => { location.replace(TARGET); }, []);
  return (
    <div className="page">
      <p className="muted">Team and roles are now part of the Company page. <a href={TARGET}>Open Company</a>.</p>
    </div>
  );
}
