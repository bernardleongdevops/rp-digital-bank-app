/**
 * BFF proxy endpoint: `POST /api/ai/chat` (AI banking assistant, Phase 1).
 *
 * Proxies a single chat turn to the bank backend's `ai-assistant-service`,
 * reached through the sandbox gateway at `POST {SANDBOX_API_BASE_URL}/ai/chat`.
 * The AI itself lives entirely in the backend: this app NEVER calls the model
 * provider and holds no model-provider key. This route only forwards the chat
 * turn, exactly like the app's other sandbox calls (`/api/bff/accounts`, ...).
 *
 * Security posture (mirrors the BFF read/transfer routes):
 *   - Requires a valid NextAuth session; when unauthenticated it responds 401
 *     WITHOUT calling the backend (`requireSession`), so an unauthenticated
 *     browser never triggers an outbound call.
 *   - The OIDC access token and the `X-Sandbox-Key` are resolved and injected
 *     strictly server-side inside `chatWithAssistant` (via `buildHeaders`) and
 *     never appear in the response (Requirements 6.1-6.3, 6.7).
 *   - The response forwards only the backend's JSON reply + its status on
 *     success, and the app's standard `{ status, error }` envelope on failure
 *     (401 session expired, 429 rate limited, 504 timeout, 502 network, and a
 *     clamped upstream status otherwise).
 *
 * No new env vars: `chatWithAssistant` reuses `SANDBOX_API_BASE_URL` and
 * `SANDBOX_API_KEY` from the existing server-only config.
 */

import { NextResponse } from 'next/server';
import { chatWithAssistant } from '@/lib/server/sandboxClient';
import type {
  AssistantChatRequest,
  ChatMessage,
  TransferConfirmationDecision,
} from '@/lib/types';
import { errorResponse, requireSession } from '../../bff/_lib/respond';

// Reads session/cookies and performs an outbound call; never statically
// optimized and always runs on the Node.js runtime (same as the BFF routes).
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Keep at most this many prior turns; a defence-in-depth cap matching the
 *  client's own ~10-turn trim so an oversized history can't be forwarded. */
const MAX_HISTORY_TURNS = 10;

/** True when a value is a well-formed chat turn `{ role, content }`. */
function isChatMessage(value: unknown): value is ChatMessage {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    (v.role === 'user' || v.role === 'assistant') &&
    typeof v.content === 'string'
  );
}

/**
 * True when a value is a well-formed transfer-confirmation decision
 * `{ confirmationToken: string, confirmed: boolean }`. The token is opaque and
 * forwarded verbatim; it is never inspected here.
 */
function isConfirmationDecision(
  value: unknown,
): value is TransferConfirmationDecision {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.confirmationToken === 'string' && typeof v.confirmed === 'boolean';
}

/**
 * Validate/normalize the untrusted request body into an `AssistantChatRequest`
 * (server-side defence-in-depth). A turn must carry EITHER a non-empty
 * `message` OR a valid `confirmation` decision (the transfer-confirmation
 * handshake sends only a `confirmation`, no message). Returns a safe `error`
 * code on the first violation without echoing any user input:
 *   - body not a JSON object                       -> `INVALID_BODY`
 *   - `message` present but empty/not a string      -> `INVALID_MESSAGE`
 *   - `confirmation` present but malformed           -> `INVALID_CONFIRMATION`
 *   - neither a usable `message` nor `confirmation`  -> `INVALID_BODY`
 * `history` is coerced to a clean array of valid turns (anything else dropped)
 * and trimmed to the last MAX_HISTORY_TURNS. A valid `confirmation` is
 * forwarded verbatim (the opaque `confirmationToken` is never logged).
 */
type Validated =
  | { ok: true; value: AssistantChatRequest }
  | { ok: false; error: string };

function validateChatBody(body: unknown): Validated {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, error: 'INVALID_BODY' };
  }
  const b = body as Record<string, unknown>;

  // A message, when present, must be a non-empty string.
  const hasMessage = b.message !== undefined && b.message !== null;
  if (hasMessage && (typeof b.message !== 'string' || b.message.trim().length === 0)) {
    return { ok: false, error: 'INVALID_MESSAGE' };
  }

  // A confirmation, when present, must be a well-formed decision.
  const hasConfirmation = b.confirmation !== undefined && b.confirmation !== null;
  if (hasConfirmation && !isConfirmationDecision(b.confirmation)) {
    return { ok: false, error: 'INVALID_CONFIRMATION' };
  }

  // A turn must carry at least one of: a usable message, or a confirmation.
  if (!hasMessage && !hasConfirmation) {
    return { ok: false, error: 'INVALID_BODY' };
  }

  const history = Array.isArray(b.history)
    ? b.history.filter(isChatMessage).slice(-MAX_HISTORY_TURNS)
    : [];

  const value: AssistantChatRequest = { history };
  if (hasMessage) {
    value.message = b.message as string;
  }
  if (hasConfirmation) {
    value.confirmation = b.confirmation as TransferConfirmationDecision;
  }
  return { ok: true, value };
}

export async function POST(req: Request) {
  // 1. Require a valid session BEFORE touching the body or the backend.
  const unauthorized = await requireSession();
  if (unauthorized) return unauthorized;

  // 2. Parse the JSON body, tolerating a malformed/empty payload.
  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return errorResponse(400, 'INVALID_BODY');
  }

  // 3. Validate server-side before any outbound call.
  const validation = validateChatBody(rawBody);
  if (!validation.ok) {
    return errorResponse(400, validation.error);
  }

  // 4. Proxy to the backend assistant and map the typed outcome to HTTP,
  //    using the app's standard error conventions. The access token and
  //    Sandbox_Key are injected server-side inside `chatWithAssistant`.
  const result = await chatWithAssistant(validation.value);

  switch (result.kind) {
    case 'OK':
      // Forward the backend's JSON reply and its (2xx) status verbatim.
      return NextResponse.json(result.reply, { status: result.status });
    case 'UNAUTHENTICATED':
      // Session expired / no usable token: the browser re-authenticates.
      return errorResponse(401, 'UNAUTHENTICATED');
    case 'RATE_LIMITED':
      return errorResponse(429, 'RATE_LIMITED');
    case 'ERROR':
      switch (result.reason) {
        case 'TIMEOUT':
          return errorResponse(504, 'TIMEOUT');
        case 'NETWORK':
          return errorResponse(502, 'NETWORK');
        case 'HTTP':
          // Clamp a non-2xx upstream status to a sane browser-facing status.
          return errorResponse(
            typeof result.status === 'number' && result.status >= 400 && result.status <= 599
              ? result.status
              : 502,
            'ASSISTANT_ERROR',
          );
        case 'UNEXPECTED':
        default:
          return errorResponse(502, 'UNEXPECTED');
      }
    default:
      return errorResponse(502, 'UNEXPECTED');
  }
}
