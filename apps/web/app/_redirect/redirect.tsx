'use client';

import { useEffect } from 'react';

/** Client redirect for a merged page; keeps the query and hash, with a link in case scripts are slow. */
export function Redirect({ to, label, note }: { to: string; label: string; note: string }) {
  useEffect(() => { location.replace(`${to}${location.search}${location.hash}`); }, [to]);
  return (
    <div className="page" data-testid="redirect">
      <p className="muted">{note} <a href={to} data-testid="redirect-link">{label}</a>.</p>
    </div>
  );
}
