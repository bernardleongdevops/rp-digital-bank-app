/**
 * BFF read endpoint: `GET /api/bff/accounts/[accountNumber]/transactions`.
 *
 * Proxies the statement history for one owned account from the sandbox
 * (`GET /transactions/accounts/{accountNumber}`, Requirement 3.2), forwarding
 * the optional `from`/`to` ISO-8601 date-range query params.
 *
 * Range handling (Requirements 3.3, 3.4):
 *   - `from`/`to` are forwarded to the sandbox only when BOTH are present and
 *     the range is valid (`from <= to`).
 *   - An invalid range (either value not a parseable date, or `from > to`) is
 *     rejected with 400 BEFORE the sandbox is called, so no outbound request
 *     is made for a bad range.
 *   - When neither value is supplied, the full history is requested.
 *   - A single value (only `from` or only `to`) is not a complete range, so it
 *     is ignored and the full history is requested (matching the design's
 *     "forward only when present" rule for a two-sided filter).
 *
 * Requires a valid session; when unauthenticated it responds 401 WITHOUT
 * calling the sandbox. Credentials are resolved server-side inside
 * `sandboxClient` and never appear in the response (Requirement 6.7).
 */

import { getTransactions } from '@/lib/server/sandboxClient';
import { errorResponse, requireSession, respondFromResult } from '../../../_lib/respond';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface RouteContext {
  params: { accountNumber: string };
}

/** Parse an ISO-8601 timestamp to epoch millis, or `null` when unparseable. */
function parseIsoDate(value: string): number | null {
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

export async function GET(req: Request, { params }: RouteContext) {
  const unauthorized = await requireSession();
  if (unauthorized) return unauthorized;

  const accountNumber = params.accountNumber?.trim();
  if (!accountNumber) {
    return errorResponse(400, 'INVALID_ACCOUNT_NUMBER');
  }

  const { searchParams } = new URL(req.url);
  const fromRaw = searchParams.get('from');
  const toRaw = searchParams.get('to');

  // Only treat the range as a filter when BOTH bounds are present.
  let range: { from: string; to: string } | undefined;
  if (fromRaw && toRaw) {
    const fromMs = parseIsoDate(fromRaw);
    const toMs = parseIsoDate(toRaw);

    // Reject a malformed date value before calling the sandbox.
    if (fromMs === null || toMs === null) {
      return errorResponse(400, 'INVALID_DATE_RANGE');
    }
    // Reject an inverted range (from > to) before calling the sandbox
    // (Requirement 3.4).
    if (fromMs > toMs) {
      return errorResponse(400, 'INVALID_DATE_RANGE');
    }

    range = { from: fromRaw, to: toRaw };
  }

  const result = await getTransactions(accountNumber, range);
  return respondFromResult(result);
}
