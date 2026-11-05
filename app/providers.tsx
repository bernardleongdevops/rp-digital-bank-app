'use client';

/**
 * Client-side providers for the Banking_App.
 *
 * Wraps the app in next-auth's `SessionProvider` so client components (the
 * `/login` sign-in action, the logout control, and the data views) can call
 * `useSession`, `signIn`, and `signOut`. The provider only ever receives the
 * non-sensitive session shape exposed by the `session` callback -- it never
 * carries the Keycloak access token to the browser.
 */

import { SessionProvider } from 'next-auth/react';
import type { ReactNode } from 'react';
import { AssistantGate } from '@/app/components/AssistantGate';

export function Providers({ children }: { children: ReactNode }) {
  return (
    <SessionProvider>
      {children}
      {/* App-wide AI assistant: renders only when authenticated. */}
      <AssistantGate />
    </SessionProvider>
  );
}
