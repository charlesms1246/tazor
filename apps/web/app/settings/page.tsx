'use client';

import { Redirect } from '../_redirect/redirect.tsx';

export default function SettingsRedirect() {
  return <Redirect to="/security/" label="Open Security & settings" note="Settings moved to Security & settings." />;
}
