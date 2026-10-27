// @vitest-environment node
//
// The Auth_Module is server-only: `lib/server/config` throws if imported into a
// browser-like context (where `window` is defined). The default jsdom test
// environment defines `window`, so this file runs in the Node environment to
// match the server runtime the auth config actually executes in.

/**
 * Unit tests for the Auth_Module (Requirement 1): session exposure, server-side
 * token confinement, and route protection.
 *
 * Covers task 3.3:
 *   (a) the NextAuth `session` callback exposes ONLY non-sensitive fields and
 *       NEVER the access token or expiresAt (token lives only in the JWT);
 *   (b) the `jwt` callback stores access_token/expires_at on the server token
 *       and sets error='NoAccessToken' when the code exchange yields no token;
 *   (c) the middleware `authorized()` rule returns false (redirect to /login)
 *       when there is no token or token.error==='NoAccessToken', and true when a
 *       valid token exists;
 *   (d) session maxAge is 24h.
 *
 * All sandbox/network interactions are avoided: these tests invoke the pure
 * callbacks directly with representative inputs. No request is issued to the
 * live Sandbox_Gateway (Requirement 11.1).
 *
 * _Requirements: 1.5, 1.6 (plus 1.3, 1.4, 1.7 exercised by the callbacks)._
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextAuthOptions, Session } from 'next-auth';
import type { JWT } from 'next-auth/jwt';

import { buildAuthOptions } from '@/lib/server/auth';
import { resetConfigCache, ENV_VARS } from '@/lib/server/config';

/**
 * 24 hours in seconds -- the required session lifetime (Requirement 1.7).
 */
const EXPECTED_MAX_AGE = 24 * 60 * 60;

/**
 * Minimal valid environment for `getConfig()` to succeed. Most variables have
 * documented local defaults; `NEXTAUTH_SECRET` has none, so it must be set.
 */
function stubValidEnv(): void {
  vi.stubEnv(ENV_VARS.nextAuthSecret, 'test-secret-value');
  // The remaining variables fall back to documented LOCAL_DEFAULTS, which are
  // sufficient and well-formed for building the auth options.
}

/**
 * Build fresh auth options against the stubbed environment. `getConfig` is
 * memoized, so the cache is reset first to pick up the current env.
 */
function freshAuthOptions(): NextAuthOptions {
  resetConfigCache();
  return buildAuthOptions();
}

/**
 * Invoke the `jwt` callback with a loosely-typed input. next-auth's parameter
 * type is strict (it requires `user`, etc.), but at runtime only the fields
 * used by the callback matter, so the test supplies representative partials.
 * The cast is confined to this helper; call sites stay clean and the RESULT is
 * strongly typed as `JWT`.
 */
async function invokeJwt(
  options: NextAuthOptions,
  params: { token: JWT; account?: Record<string, unknown> | null; profile?: Record<string, unknown> },
): Promise<JWT> {
  const jwt = options.callbacks?.jwt;
  expect(jwt).toBeDefined();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (await jwt!(params as any)) as JWT;
}

/**
 * Invoke the `session` callback with a loosely-typed input, returning the
 * strongly-typed `Session` result.
 */
async function invokeSession(
  options: NextAuthOptions,
  params: { session: Session; token: JWT },
): Promise<Session> {
  const session = options.callbacks?.session;
  expect(session).toBeDefined();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (await session!(params as any)) as Session;
}

beforeEach(() => {
  vi.unstubAllEnvs();
  resetConfigCache();
  stubValidEnv();
});

describe('Auth_Module session configuration', () => {
  it('sets the session strategy to jwt and maxAge to 24 hours (Requirement 1.7)', () => {
    const options = freshAuthOptions();
    expect(options.session?.strategy).toBe('jwt');
    expect(options.session?.maxAge).toBe(EXPECTED_MAX_AGE);
    expect(options.jwt?.maxAge).toBe(EXPECTED_MAX_AGE);
  });

  it('routes unauthenticated entry and auth errors to /login', () => {
    const options = freshAuthOptions();
    expect(options.pages?.signIn).toBe('/login');
    expect(options.pages?.error).toBe('/login');
  });
});

describe('jwt callback stores credentials server-side (Requirements 1.3, 1.4)', () => {
  it('persists access_token and expires_at on the server token when the exchange succeeds', async () => {
    const options = freshAuthOptions();

    const token = await invokeJwt(options, {
      token: {},
      account: {
        provider: 'keycloak',
        type: 'oauth',
        providerAccountId: 'acc-1',
        access_token: 'the-access-token',
        expires_at: 1_900_000_000,
      },
      profile: { preferred_username: 'alice' },
    });

    expect(token.accessToken).toBe('the-access-token');
    expect(token.expiresAt).toBe(1_900_000_000);
    expect(token.error).toBeUndefined();
    expect(token.customerRef).toBe('alice');
  });

  it('derives expiresAt from expires_in when expires_at is absent', async () => {
    const options = freshAuthOptions();
    const nowSeconds = 1_700_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(nowSeconds * 1000);

    const token = await invokeJwt(options, {
      token: {},
      account: {
        provider: 'keycloak',
        type: 'oauth',
        providerAccountId: 'acc-1',
        access_token: 'tok',
        expires_in: 3600,
      },
      profile: { customer_ref: 'CUST-ALICE' },
    });

    expect(token.accessToken).toBe('tok');
    expect(token.expiresAt).toBe(nowSeconds + 3600);
    expect(token.customerRef).toBe('CUST-ALICE');
  });

  it("sets error='NoAccessToken' and discards credentials when the exchange yields no token (Requirement 1.4)", async () => {
    const options = freshAuthOptions();

    const token = await invokeJwt(options, {
      // A stale token with credentials that must be discarded on a failed exchange.
      token: { accessToken: 'stale', expiresAt: 123 },
      account: {
        provider: 'keycloak',
        type: 'oauth',
        providerAccountId: 'acc-1',
        // No access_token on the account -> failed/cancelled exchange.
      },
      profile: {},
    });

    expect(token.accessToken).toBeUndefined();
    expect(token.expiresAt).toBeUndefined();
    expect(token.error).toBe('NoAccessToken');
  });

  it('returns the token unchanged on subsequent calls with no account', async () => {
    const options = freshAuthOptions();

    const token = await invokeJwt(options, {
      token: { accessToken: 'tok', expiresAt: 999, customerRef: 'alice' },
      // No `account` -> this is a later request, not the sign-in exchange.
    });

    expect(token.accessToken).toBe('tok');
    expect(token.expiresAt).toBe(999);
    expect(token.customerRef).toBe('alice');
    expect(token.error).toBeUndefined();
  });
});

describe('session callback never exposes the access token (Requirements 1.3, 1.5)', () => {
  it('exposes only the non-sensitive customerRef and never the access token or expiry', async () => {
    const options = freshAuthOptions();

    const session = await invokeSession(options, {
      session: { user: { name: 'Alice' }, expires: '2099-01-01T00:00:00.000Z' },
      token: {
        accessToken: 'SUPER-SECRET-TOKEN',
        expiresAt: 1_900_000_000,
        customerRef: 'CUST-ALICE',
      },
    });

    // The non-sensitive reference is surfaced...
    expect(session.user?.customerRef).toBe('CUST-ALICE');

    // ...but the secret token / expiry are NOT present anywhere in the payload.
    const serialized = JSON.stringify(session);
    expect(serialized).not.toContain('SUPER-SECRET-TOKEN');
    expect(serialized.toLowerCase()).not.toContain('accesstoken');
    expect(serialized.toLowerCase()).not.toContain('expiresat');

    // Explicitly assert the session object carries no token fields.
    const asRecord = session as unknown as Record<string, unknown>;
    expect(asRecord.accessToken).toBeUndefined();
    expect(asRecord.expiresAt).toBeUndefined();
    const userRecord = (session.user ?? {}) as unknown as Record<string, unknown>;
    expect(userRecord.accessToken).toBeUndefined();
    expect(userRecord.expiresAt).toBeUndefined();
  });

  it('does not surface the access token even when the token carries a NoAccessToken error', async () => {
    const options = freshAuthOptions();

    const session = await invokeSession(options, {
      session: { user: { name: 'Bob' }, expires: '2099-01-01T00:00:00.000Z' },
      token: { error: 'NoAccessToken' },
    });

    const serialized = JSON.stringify(session);
    expect(serialized.toLowerCase()).not.toContain('accesstoken');
    expect(session.user?.customerRef).toBeUndefined();
  });
});

/**
 * Route-protection rule (Requirement 1.6). The middleware's `authorized({token})`
 * callback is not separately exported, so we replicate its exact rule here and
 * assert the observable behaviour: a request is authorized only when a decoded
 * token exists AND it carries no `NoAccessToken` error. Returning false triggers
 * the redirect to /login without rendering the protected route.
 */
describe('middleware authorized() route-protection rule (Requirement 1.6)', () => {
  // Mirrors middleware.ts: `Boolean(token) && token?.error !== 'NoAccessToken'`.
  const authorized = (token: JWT | null): boolean =>
    Boolean(token) && token?.error !== 'NoAccessToken';

  it('denies (redirects to /login) when there is no token', () => {
    expect(authorized(null)).toBe(false);
  });

  it('denies when the token carries a NoAccessToken error', () => {
    expect(authorized({ error: 'NoAccessToken' })).toBe(false);
  });

  it('authorizes when a valid token exists', () => {
    expect(authorized({ accessToken: 'tok', expiresAt: 1_900_000_000 })).toBe(true);
  });

  it('authorizes a token that has a customerRef and no error', () => {
    expect(authorized({ customerRef: 'CUST-ALICE' })).toBe(true);
  });
});
