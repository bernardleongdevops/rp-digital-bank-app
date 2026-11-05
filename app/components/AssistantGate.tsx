'use client';

/**
 * Renders the AI banking-assistant {@link ChatWidget} app-wide, but ONLY when
 * the visitor is authenticated. Mounted once inside `Providers` (within the
 * NextAuth `SessionProvider`) so the floating assistant appears on every
 * signed-in page without each page having to include it, and never appears on
 * public pages such as `/login`.
 *
 * `useSession` only ever sees the non-sensitive session shape; the access
 * token stays server-side. We treat `status === 'authenticated'` as the gate.
 */

import { useSession } from 'next-auth/react';
import { ChatWidget } from '@/app/components/ChatWidget';

export function AssistantGate() {
  const { status } = useSession();
  if (status !== 'authenticated') return null;
  return <ChatWidget />;
}
