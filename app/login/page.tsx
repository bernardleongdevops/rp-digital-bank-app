/**
 * `/login` page -- the Banking_App's unauthenticated entry point (Requirement
 * 1.1, 1.5, 1.6). Middleware redirects unauthenticated requests for protected
 * views here, and `signOut` returns the customer here after logout.
 *
 * The interactive sign-in action and `?error=` handling live in `LoginClient`,
 * a client component. It is wrapped in a `Suspense` boundary because it reads
 * the URL search params via `useSearchParams`, which Next.js App Router
 * requires to be suspense-bounded so the rest of the page can still be
 * statically rendered.
 */

import { Suspense } from 'react';
import { LoginClient } from './LoginClient';

export default function LoginPage() {
  return (
    <Suspense fallback={<main><h1>FiNova Digital Bank</h1></main>}>
      <LoginClient />
    </Suspense>
  );
}
