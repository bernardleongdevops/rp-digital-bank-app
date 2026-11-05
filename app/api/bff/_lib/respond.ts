/**
 * Shared server-only helpers for the read-endpoint BFF route handlers
 * (task 5.1). These are the thin glue between the typed `sandboxClient`
 * functions and the HTTP responses the browser receives.
 *
 * Security posture (Requirement 6.7): the only things ever forwarded to the
 * browser are
 *   - the parsed JSON `data` on success, and
 *   - a numeric `status` plus a machine-readable `error` code on failure.
 * The access token and the Sandbox_Key are resolved entirely inside
 * `sandboxClient` and are structurally absent from a `SandboxResult<T>`, so
 * nothing secret can reach any response header, body, or cookie here. We also
 * never log the result, so no secret can leak via logs.
 */

import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { getAuthOptions } from '@/lib/server/auth';
import type { SandboxResult, TransferResult } from '@/lib/types';

/**
 * A minimal, browser-safe error envelope. Carries only a numeric `status` and
 * a machine-readable `error` code — never a token, key, upstream message, or
 * path (Requirement 6.7).
 */
interface BffErrorPayload {
  status: number;
  error: string;
}

/**
 * Require an authenticated session before any sandbox call is made.
 *
 * Returns a ready-to-send 401 `NextResponse` when there is no valid session,
 * or `null` when the caller may proceed. The 401 is produced WITHOUT invoking
 * the sandbox (defence-in-depth alongside `sandboxClient`'s own missing-token
 * guard), so an unauthenticated browser never triggers an outbound call.
 *
 * A session is considered valid only when `getServerSession` returns a
 * non-null session object; the client-facing session never carries the access
 * token, so this is purely a presence/authentication check.
 */
export async function requireSession(): Promise<NextResponse | null> {
  const session = await getServerSession(getAuthOptions());
  if (!session) {
    return errorResponse(401, 'UNAUTHENTICATED');
  }
  return null;
}

/** Build a browser-safe JSON error response with only `status` + `error`. */
export function errorResponse(status: number, error: string): NextResponse<BffErrorPayload> {
  return NextResponse.json({ status, error }, { status });
}

/**
 * Clamp an upstream HTTP status to a sane browser-facing status. Any upstream
 * value that is not a real 4xx/5xx is surfaced as 502 (Bad Gateway) so a
 * malformed upstream status can never produce an invalid HTTP response.
 */
function clampHttpStatus(status: number | undefined): number {
  if (typeof status === 'number' && status >= 400 && status <= 599) {
    return status;
  }
  return 502;
}

/**
 * Map a typed {@link SandboxResult} to the HTTP response the browser receives.
 *
 * Mapping (Requirement 6.7 and the design "Read-endpoint error handling"
 * section):
 *   - `OK`              -> 200 with the parsed JSON data.
 *   - `UNAUTHENTICATED` -> 401 with `error: 'UNAUTHENTICATED'` (the browser
 *                          routes to re-authentication).
 *   - `RATE_LIMITED`    -> 429 with `error: 'RATE_LIMITED'`.
 *   - `ERROR`:
 *       - reason `TIMEOUT` -> 504 Gateway Timeout (`error: 'TIMEOUT'`).
 *       - reason `NETWORK` -> 502 Bad Gateway  (`error: 'NETWORK'`).
 *       - reason `HTTP`    -> the clamped upstream status, forwarding the
 *                             upstream `error` code when present (e.g. a 404
 *                             for an account that is not owned, or an
 *                             `ORIGIN_NOT_PERMITTED` 403 per Requirement 10.6).
 *       - reason `UNEXPECTED` -> 502 Bad Gateway (`error: 'UNEXPECTED'`).
 *
 * No branch includes anything beyond `status` + `error`/`data`, so no secret
 * is ever exposed.
 */
export function respondFromResult<T>(result: SandboxResult<T>): NextResponse {
  switch (result.kind) {
    case 'OK':
      return NextResponse.json(result.data, { status: 200 });
    case 'UNAUTHENTICATED':
      return errorResponse(401, 'UNAUTHENTICATED');
    case 'RATE_LIMITED':
      return errorResponse(429, 'RATE_LIMITED');
    case 'ERROR': {
      switch (result.reason) {
        case 'TIMEOUT':
          return errorResponse(504, 'TIMEOUT');
        case 'NETWORK':
          return errorResponse(502, 'NETWORK');
        case 'HTTP':
          return errorResponse(clampHttpStatus(result.status), result.error ?? 'HTTP_ERROR');
        case 'UNEXPECTED':
        default:
          return errorResponse(502, 'UNEXPECTED');
      }
    }
    default:
      // Exhaustiveness guard: an unknown kind is surfaced as a safe 502.
      return errorResponse(502, 'UNEXPECTED');
  }
}

/**
 * Map a typed {@link TransferResult} to the HTTP response the browser receives
 * for `POST /api/bff/transfers` (task 5.2).
 *
 * The transfer outcome is a different, more specific discriminated union than
 * `SandboxResult<T>`: it carries the exact transfer semantics (AML hold/block,
 * business conflict with an `error` code + `message`, etc.). The browser-facing
 * HTTP status mirrors the upstream transfer semantics 1:1 so the client's
 * `TransferResultBanner` can re-derive the outcome from the response status +
 * `error` code alone (Requirements 4.3-4.10):
 *
 *   - `COMPLETED`       -> 201 (`error: 'COMPLETED'`).
 *   - `AML_HELD`        -> 202 (`error: 'AML_HELD'`).
 *   - `AML_BLOCKED`     -> 422 (`error: 'AML_BLOCKED'`).
 *   - `CONFLICT`        -> 409, forwarding the upstream `error` code (e.g.
 *                          `INSUFFICIENT_FUNDS` / `SAME_ACCOUNT` /
 *                          `CURRENCY_MISMATCH` / `INVALID_AMOUNT`) and the
 *                          human `message` so the banner can explain it. An
 *                          `Error_Body` carries nothing secret, so forwarding
 *                          `message` here is safe.
 *   - `FORBIDDEN`       -> 403 (`error: 'FORBIDDEN'`).
 *   - `UNAUTHENTICATED` -> 401 (`error: 'UNAUTHENTICATED'`); the browser routes
 *                          to re-authentication.
 *   - `RATE_LIMITED`    -> 429 (`error: 'RATE_LIMITED'`); the banner shows a
 *                          rate-limit message with no auto-retry.
 *   - `ERROR`:
 *       - reason `TIMEOUT`   -> 504 Gateway Timeout (`error: 'TIMEOUT'`).
 *       - reason `NETWORK`   -> 502 Bad Gateway     (`error: 'NETWORK'`).
 *       - reason `UNEXPECTED`-> 502 Bad Gateway     (`error: 'UNEXPECTED'`).
 *         A credential-less `createTransfer` surfaces as `UNEXPECTED` with no
 *         status; it is mapped to 502 here (not 401) because no HTTP exchange
 *         occurred — the dedicated 401 path is reserved for an upstream 401
 *         (`UNAUTHENTICATED`). `requireSession` already guards the common
 *         unauthenticated case with a 401 before the sandbox is ever called.
 *
 * No branch includes anything beyond `status` + `error` (+ a non-secret
 * `message` for 409), so the access token and Sandbox_Key are never exposed.
 */
/**
 * Map a typed {@link SandboxResult} to the HTTP response the browser receives
 * for a *mutating* new BFF route — open/close account, create/delete payee,
 * create/cancel scheduled transfer, and profile update (task 2.3).
 *
 * This is a thin wrapper over {@link respondFromResult}: it differs only in the
 * `OK` branch, where a successful mutation forwards a distinct success status
 * so the client can tell a created/accepted mutation apart from a plain 200
 * read. The status is `201 Created` by default and overridable via
 * `createdStatus` (e.g. `202 Accepted` for an asynchronously-processed
 * mutation). Every non-`OK` variant is delegated to {@link respondFromResult}
 * so the 401 / 429 / timeout / network / clamped-HTTP (with forwarded upstream
 * `error` code, e.g. a 403 or 409) / unexpected branches behave identically —
 * a single source of truth for the error mapping.
 *
 * Because the `OK` branch forwards only the parsed JSON `data` with the chosen
 * status, and every error branch is `respondFromResult`'s (which forwards only
 * `status` + `error`), nothing beyond `status` + `error`/`data` is ever
 * returned: the access token, the Sandbox_Key, and the raw upstream request
 * headers are structurally absent from a `SandboxResult<T>` and never reach any
 * response status line, header, body, or cookie (Requirements 9.2, 9.4, 9.7).
 *
 * @param result  the typed outcome from a mutating `sandboxClient` function.
 * @param opts.createdStatus  the success status to forward for an `OK` result;
 *                            defaults to `201`. Use `202` for accepted-but-not-
 *                            yet-completed mutations.
 */
export function respondFromMutationResult<T>(
  result: SandboxResult<T>,
  opts?: { createdStatus?: number },
): NextResponse {
  if (result.kind === 'OK') {
    const createdStatus = opts?.createdStatus ?? 201;
    return NextResponse.json(result.data, { status: createdStatus });
  }
  // All non-OK variants reuse the existing read mapping identically:
  //   UNAUTHENTICATED -> 401, RATE_LIMITED -> 429, ERROR TIMEOUT -> 504,
  //   NETWORK -> 502, HTTP -> clamped upstream status + forwarded error code
  //   (so a 403/409 upstream forwards with its error code), UNEXPECTED -> 502.
  return respondFromResult(result);
}

export function respondFromTransferResult(result: TransferResult): NextResponse {
  switch (result.kind) {
    case 'COMPLETED':
      return NextResponse.json({ status: 201, error: 'COMPLETED' }, { status: 201 });
    case 'AML_HELD':
      return NextResponse.json({ status: 202, error: 'AML_HELD' }, { status: 202 });
    case 'AML_BLOCKED':
      return NextResponse.json({ status: 422, error: 'AML_BLOCKED' }, { status: 422 });
    case 'CONFLICT':
      return NextResponse.json(
        { status: 409, error: result.error, message: result.message },
        { status: 409 },
      );
    case 'FORBIDDEN':
      return errorResponse(403, 'FORBIDDEN');
    case 'UNAUTHENTICATED':
      return errorResponse(401, 'UNAUTHENTICATED');
    case 'RATE_LIMITED':
      return errorResponse(429, 'RATE_LIMITED');
    case 'ERROR': {
      switch (result.reason) {
        case 'TIMEOUT':
          return errorResponse(504, 'TIMEOUT');
        case 'NETWORK':
          return errorResponse(502, 'NETWORK');
        case 'UNEXPECTED':
        default:
          return errorResponse(502, 'UNEXPECTED');
      }
    }
    default:
      // Exhaustiveness guard: an unknown kind is surfaced as a safe 502.
      return errorResponse(502, 'UNEXPECTED');
  }
}
