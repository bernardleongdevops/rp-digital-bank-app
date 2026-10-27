/**
 * Server-only Sandbox_Gateway client (the BFF choke point).
 *
 * This module is the single place where outbound calls to the Sandbox_Gateway
 * are made. It is responsible for the whole security posture of Requirement 6:
 *
 *  - It resolves the two credentials strictly server-side: the OIDC access
 *    token (read from the NextAuth JWT, which is NOT exposed on the client
 *    `Session`) and the Sandbox_Key (from `getConfig().sandboxApiKey`).
 *  - It injects `Authorization: Bearer <token>`, `X-Sandbox-Key: <key>`, and
 *    `Content-Type: application/json` on every outbound call (Requirement 6.1).
 *  - If either credential is missing it returns an `UNAUTHENTICATED` result
 *    WITHOUT issuing the outbound request (Requirement 6.5).
 *  - It enforces a per-call timeout via `AbortController` (10s reads, 30s
 *    transfers), mapping an abort to a `TIMEOUT` error and a connectivity
 *    failure to `NETWORK` (Requirements 6.6, 6.1).
 *  - It normalizes upstream responses and the sandbox `Error_Body` into the
 *    typed `SandboxResult<T>` union, forwarding only `status` + `error` code,
 *    and NEVER lets the access token or API key leak into returned data, logs,
 *    or thrown errors (Requirements 6.2, 6.3, 6.7).
 *  - A CORS origin-denied response from the gateway fails the request with an
 *    origin-not-permitted outcome (Requirement 10.6).
 *
 * Design for testability (tasks 4.3/4.4/4.5): the token provider, config
 * provider and `fetch` implementation are all injectable via `SandboxDeps`,
 * and the header-building logic is a pure, exported helper (`buildHeaders`).
 * The default dependencies read from the real session/config/global fetch.
 *
 * Server-only posture: this module follows the same convention as
 * `lib/server/config.ts` — rather than relying on the `server-only` package,
 * the request/session-bound default dependencies guard against a browser
 * context at call time. The pure helpers and the injectable code path remain
 * importable from tests in any environment, and `next/headers` / `getToken`
 * are imported lazily so merely importing this module never pulls in the
 * request-scoped Next.js server APIs.
 */

import { getConfig } from '@/lib/server/config';
import type {
  Account,
  Customer,
  SandboxResult,
  Transaction,
  TransactionDirection,
  TransferRequest,
  TransferResult,
} from '@/lib/types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default per-call timeout for data reads (Requirement 6.1/6.6). */
export const READ_TIMEOUT_MS = 10_000;

/** Per-call timeout for transfers (Requirement 4.10). */
export const TRANSFER_TIMEOUT_MS = 30_000;

/**
 * The origin every outbound request is sent from (Requirement 10.5). This is
 * the registered `sandbox-web` web origin on the Keycloak client and the CORS
 * allowed origin on the gateway.
 */
export const REQUEST_ORIGIN = 'http://localhost:3000';

// ---------------------------------------------------------------------------
// Injectable dependencies (for unit/property testing)
// ---------------------------------------------------------------------------

/** The minimal slice of config `sandboxFetch` needs. */
export interface SandboxConfig {
  readonly sandboxApiBaseUrl: string;
  readonly sandboxApiKey: string;
}

/**
 * Dependencies `sandboxFetch` relies on. All are optional; when omitted the
 * real server-side implementations are used. Tests inject fakes here so no
 * real session, config or network is required.
 */
export interface SandboxDeps {
  /** Resolve the OIDC access token from the server session. */
  getAccessToken?: () => Promise<string | undefined>;
  /** Resolve the config slice (base URL + API key). */
  getSandboxConfig?: () => SandboxConfig;
  /** The `fetch` implementation to use for the outbound call. */
  fetchImpl?: typeof fetch;
}

/** Options for a single `sandboxFetch` call. */
export interface RequestOptions {
  /** Per-call timeout; defaults to {@link READ_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Optional caller-supplied abort signal, combined with the timeout. */
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Default dependency implementations (server-only)
// ---------------------------------------------------------------------------

/**
 * Guard against invoking the real session-reading path from client code. The
 * access token and API key resolved here must never reach the browser. Mirrors
 * the guard in `lib/server/config.ts`. The pure helpers and injectable path
 * remain usable in any environment (including tests).
 */
function assertServerOnly(): void {
  if (typeof window !== 'undefined') {
    throw new Error(
      'lib/server/sandboxClient is server-only and must not be imported from client code.',
    );
  }
}

/**
 * Read the Keycloak access token from the server-side NextAuth JWT. The token
 * lives only in the encrypted HTTP-only session cookie and is never present on
 * the client `Session`, so this is the only path to it. Returns `undefined`
 * when there is no session or the JWT carries no usable token.
 */
async function defaultGetAccessToken(): Promise<string | undefined> {
  assertServerOnly();
  // Lazily import the request-scoped Next.js server APIs so importing this
  // module (e.g. from a unit test) never evaluates them.
  const { getToken } = await import('next-auth/jwt');
  const { headers: nextHeaders, cookies: nextCookies } = await import('next/headers');

  const config = getConfig();
  // `getToken` needs the request cookies and the secret; in the App Router we
  // reconstruct a minimal request-like object from `next/headers`.
  const cookieStore = nextCookies();
  const cookieHeader = cookieStore
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');

  const req = {
    headers: {
      cookie: cookieHeader,
      // Some next-auth versions read these off the request headers.
      ...Object.fromEntries(nextHeaders().entries()),
    },
    cookies: Object.fromEntries(cookieStore.getAll().map((c) => [c.name, c.value])),
  };

  // `getToken` is typed around the Node request; the reconstructed shape is
  // sufficient for cookie-based JWT decryption.
  const token = await getToken({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    req: req as any,
    secret: config.nextAuthSecret,
  });

  if (!token || token.error === 'NoAccessToken') return undefined;
  return token.accessToken;
}

/** Default config slice provider: the validated, server-only app config. */
function defaultGetSandboxConfig(): SandboxConfig {
  const config = getConfig();
  return {
    sandboxApiBaseUrl: config.sandboxApiBaseUrl,
    sandboxApiKey: config.sandboxApiKey,
  };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Build the outbound header set for a sandbox call. Pure and exported so it is
 * directly unit-/property-testable (task 4.4). Always injects the two
 * credentials and the origin; adds `Content-Type: application/json` only when
 * the request carries a body (Requirement 6.1/6.4).
 *
 * Caller-supplied headers are applied first so the injected credentials and
 * content type cannot be overridden or dropped by the caller.
 */
export function buildHeaders(args: {
  token: string;
  apiKey: string;
  hasBody: boolean;
  extra?: HeadersInit;
}): Headers {
  const headers = new Headers(args.extra);
  headers.set('Authorization', `Bearer ${args.token}`);
  headers.set('X-Sandbox-Key', args.apiKey);
  headers.set('Origin', REQUEST_ORIGIN);
  if (args.hasBody) {
    headers.set('Content-Type', 'application/json');
  }
  return headers;
}

/** True when an error is an `AbortError` raised by `AbortController.abort()`. */
function isAbortError(err: unknown): boolean {
  return (
    err instanceof DOMException
      ? err.name === 'AbortError'
      : typeof err === 'object' && err !== null && (err as { name?: string }).name === 'AbortError'
  );
}

/**
 * The shape of a sandbox `Error_Body` we actually consume. Only `status` and
 * `error` are forwarded to the browser (Requirement 6.7); `message`/`path`/
 * `timestamp` are intentionally dropped so nothing unexpected leaks.
 */
interface ParsedErrorBody {
  status?: number;
  error?: string;
}

/** Safely parse a JSON `Error_Body`, tolerating malformed payloads. */
async function parseErrorBody(res: Response): Promise<ParsedErrorBody> {
  try {
    const body = (await res.clone().json()) as unknown;
    if (body && typeof body === 'object') {
      const b = body as Record<string, unknown>;
      return {
        status: typeof b.status === 'number' ? b.status : undefined,
        error: typeof b.error === 'string' ? b.error : undefined,
      };
    }
  } catch {
    // Non-JSON or empty body -> no extra detail.
  }
  return {};
}

/**
 * Detect a CORS origin-denied rejection from the gateway (Requirement 10.6).
 * A gateway that refuses the origin responds `403` with a body whose `error`
 * code names the origin/CORS problem. We treat that as a distinct,
 * origin-not-permitted outcome rather than a generic forbidden.
 */
function isOriginDenied(status: number, errorCode: string | undefined): boolean {
  if (status !== 403) return false;
  const code = (errorCode ?? '').toUpperCase();
  return code.includes('CORS') || code.includes('ORIGIN');
}

/**
 * Normalize an upstream {@link Response} into a typed {@link SandboxResult}.
 * Exported for direct unit testing of the mapping (task 4.5). Never includes
 * any secret: on success it returns only the parsed JSON body; on failure it
 * forwards only `status` and the `error` code.
 */
export async function normalizeResponse<T>(res: Response): Promise<SandboxResult<T>> {
  if (res.ok) {
    try {
      const data = (await res.json()) as T;
      return { kind: 'OK', data };
    } catch {
      // A 2xx with an unparseable body is an unexpected upstream contract break.
      return { kind: 'ERROR', reason: 'UNEXPECTED', status: res.status };
    }
  }

  if (res.status === 401) {
    return { kind: 'UNAUTHENTICATED' };
  }
  if (res.status === 429) {
    return { kind: 'RATE_LIMITED' };
  }

  const { error } = await parseErrorBody(res);

  if (isOriginDenied(res.status, error)) {
    // Origin-not-permitted (Requirement 10.6): surfaced as an HTTP error whose
    // code names the origin problem so the caller can message accordingly.
    return { kind: 'ERROR', reason: 'HTTP', status: res.status, error: 'ORIGIN_NOT_PERMITTED' };
  }

  return { kind: 'ERROR', reason: 'HTTP', status: res.status, error };
}

// ---------------------------------------------------------------------------
// sandboxFetch
// ---------------------------------------------------------------------------

/**
 * The single choke point for outbound Sandbox_Gateway calls.
 *
 * Resolves credentials server-side, injects headers, enforces a timeout, and
 * normalizes the outcome into a typed {@link SandboxResult}. If either
 * credential is missing, returns `UNAUTHENTICATED` without issuing a request
 * (Requirement 6.5). Secrets never appear in the returned value, and failures
 * are mapped to `TIMEOUT`/`NETWORK`/`HTTP`/`UNEXPECTED` without echoing the
 * token or key.
 *
 * @param path  Path under the configured base URL, e.g. `/customers/me`.
 * @param init  Standard `fetch` init (method/body/headers); credential headers
 *              are injected here and cannot be overridden.
 * @param opts  Per-call options (timeout, caller abort signal).
 * @param deps  Injectable dependencies for testing; real ones used by default.
 */
export async function sandboxFetch<T>(
  path: string,
  init: RequestInit = {},
  opts: RequestOptions = {},
  deps: SandboxDeps = {},
): Promise<SandboxResult<T>> {
  const getAccessToken = deps.getAccessToken ?? defaultGetAccessToken;
  const getSandboxConfig = deps.getSandboxConfig ?? defaultGetSandboxConfig;
  const fetchImpl = deps.fetchImpl ?? fetch;

  // 1. Resolve credentials strictly server-side.
  const { sandboxApiBaseUrl, sandboxApiKey } = getSandboxConfig();
  const token = await getAccessToken();

  // 2. Missing credential -> no outbound request (Requirement 6.5).
  if (!token || !sandboxApiKey) {
    return { kind: 'UNAUTHENTICATED' };
  }

  // 3. Build headers (injects credentials + origin + content type for bodies).
  const hasBody = init.body !== undefined && init.body !== null;
  const headers = buildHeaders({
    token,
    apiKey: sandboxApiKey,
    hasBody,
    extra: init.headers,
  });

  // 4. Timeout via AbortController, combined with any caller-supplied signal.
  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? READ_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onCallerAbort = () => controller.abort();
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener('abort', onCallerAbort, { once: true });
  }

  try {
    const res = await fetchImpl(`${sandboxApiBaseUrl}${path}`, {
      ...init,
      headers,
      signal: controller.signal,
      // Never attach cross-site credentials; the API key + bearer token are the
      // only credentials and they travel in headers only.
      credentials: 'omit',
    });
    return await normalizeResponse<T>(res);
  } catch (err) {
    // 5. Map failures without leaking secrets. An abort is a timeout; anything
    //    else at the transport layer is a connectivity (NETWORK) failure.
    if (isAbortError(err)) {
      return { kind: 'ERROR', reason: 'TIMEOUT' };
    }
    return { kind: 'ERROR', reason: 'NETWORK' };
  } finally {
    clearTimeout(timer);
    if (opts.signal) opts.signal.removeEventListener('abort', onCallerAbort);
  }
}

// ---------------------------------------------------------------------------
// Typed sandbox functions (task 4.2)
// ---------------------------------------------------------------------------
//
// Thin, typed wrappers over `sandboxFetch` / the transfer path. Each maps one
// sandbox endpoint from the integration contract (INTEGRATION_WITH_BANK.md
// section 4) to a typed result the BFF route handlers consume. Every function
// threads the optional `deps` param straight through so tasks 4.3/4.4/4.5 can
// inject fakes (token/config/fetch) and assert behaviour without a real
// session, config, or network.
//
// Endpoint paths are relative to the configured `sandboxApiBaseUrl`
// (`http://localhost:8081/api/v1` locally), matching the contract exactly:
//   GET  /customers/me
//   GET  /accounts
//   GET  /accounts/{accountNumber}
//   GET  /transactions/accounts/{accountNumber}   (optional from/to ISO-8601)
//   POST /payments/transfers

// ---------------------------------------------------------------------------
// Wire <-> domain mapping
// ---------------------------------------------------------------------------
//
// The sandbox JSON uses different field names than the app's domain types
// (`lib/types.ts`). We adapt the external contract to our internal shapes here,
// at the BFF boundary, so the UI and the rest of the app depend only on the
// stable domain types. Each mapper is defensive: it tolerates missing/renamed
// fields and never throws on an unexpected shape.

/** Raw `GET /customers/me` body as returned by the sandbox. */
interface WireCustomer {
  customerRef?: string;
  fullName?: string;
  name?: string;
  email?: string;
  nationalId?: string;
  kycStatus?: string;
  profile?: Customer['profile'];
}

/** Raw account element as returned by `GET /accounts` / `GET /accounts/{n}`. */
interface WireAccount {
  accountNumber?: string;
  accountType?: string;
  type?: string;
  balance?: number;
  currency?: string;
  status?: string;
}

/** Raw transaction element as returned by `GET /transactions/accounts/{n}`. */
interface WireTransaction {
  transactionRef?: string;
  id?: string;
  bookedAt?: string;
  timestamp?: string;
  amount?: number;
  direction?: string;
  description?: string;
  counterparty?: string | null;
  runningBalance?: number | null;
}

/** True when a value is a non-null, non-array object we can safely read from. */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Map a wire customer onto the domain {@link Customer}. Tolerates a null/
 * non-object input by returning an empty customer, so a malformed upstream
 * payload degrades gracefully rather than throwing.
 */
function mapCustomer(w: WireCustomer | null | undefined): Customer {
  const c = isRecord(w) ? (w as WireCustomer) : {};
  return {
    customerRef: c.customerRef ?? '',
    // The sandbox calls the display name `fullName`; fall back to `name`.
    name: c.fullName ?? c.name ?? '',
    email: c.email,
    nationalId: c.nationalId,
    kycStatus: c.kycStatus,
    profile: isRecord(c.profile) ? c.profile : undefined,
  };
}

/**
 * Map a wire account onto the domain {@link Account}. Tolerates a null/
 * non-object element gracefully.
 */
function mapAccount(w: WireAccount | null | undefined): Account {
  const a = isRecord(w) ? (w as WireAccount) : {};
  return {
    accountNumber: a.accountNumber ?? '',
    // The sandbox calls the kind `accountType`; fall back to `type`.
    type: (a.accountType ?? a.type ?? 'SAVINGS') as Account['type'],
    balance: typeof a.balance === 'number' ? a.balance : 0,
    currency: a.currency ?? '',
    status: a.status,
  };
}

/**
 * Map a wire transaction onto the domain {@link Transaction}. Tolerates a
 * null/non-object element gracefully.
 */
function mapTransaction(w: WireTransaction | null | undefined): Transaction {
  const t = isRecord(w) ? (w as WireTransaction) : {};
  return {
    // The sandbox uses `transactionRef` for the id and `bookedAt` for the time.
    id: t.transactionRef ?? t.id ?? '',
    timestamp: t.bookedAt ?? t.timestamp ?? '',
    amount: typeof t.amount === 'number' ? t.amount : 0,
    direction: (t.direction === 'DEBIT' ? 'DEBIT' : 'CREDIT') as TransactionDirection,
    description: t.description ?? '',
    counterparty: t.counterparty ?? undefined,
    runningBalance:
      typeof t.runningBalance === 'number' ? t.runningBalance : undefined,
  };
}

/** Apply `fn` to the `data` of an OK result, passing every other variant through. */
function mapResult<A, B>(result: SandboxResult<A>, fn: (data: A) => B): SandboxResult<B> {
  return result.kind === 'OK' ? { kind: 'OK', data: fn(result.data) } : result;
}

/**
 * The signed-in customer's record — `GET /customers/me` (owner-scoped by the
 * access token). Requirement 2.1. The sandbox wire shape is mapped onto the
 * domain {@link Customer}.
 */
export async function getCustomer(deps: SandboxDeps = {}): Promise<SandboxResult<Customer>> {
  const result = await sandboxFetch<WireCustomer>('/customers/me', { method: 'GET' }, {}, deps);
  return mapResult(result, mapCustomer);
}

/**
 * The signed-in customer's accounts — `GET /accounts`. Requirement 2.2. Each
 * wire account is mapped onto the domain {@link Account}.
 */
export async function listAccounts(deps: SandboxDeps = {}): Promise<SandboxResult<Account[]>> {
  const result = await sandboxFetch<WireAccount[]>('/accounts', { method: 'GET' }, {}, deps);
  return mapResult(result, (list) => (Array.isArray(list) ? list.map(mapAccount) : []));
}

/**
 * One owned account by number — `GET /accounts/{accountNumber}` (the gateway
 * returns 404 if the account is not owned). Requirement 3.1.
 *
 * The account number is URL-path-encoded so an unusual value cannot alter the
 * request path.
 */
export async function getAccount(
  accountNumber: string,
  deps: SandboxDeps = {},
): Promise<SandboxResult<Account>> {
  const path = `/accounts/${encodeURIComponent(accountNumber)}`;
  const result = await sandboxFetch<WireAccount>(path, { method: 'GET' }, {}, deps);
  return mapResult(result, mapAccount);
}

/**
 * Statement history for an owned account —
 * `GET /transactions/accounts/{accountNumber}` with optional `from`/`to`
 * ISO-8601 query params (Requirement 3.2). The range values are forwarded only
 * when present; the caller (BFF/view) is responsible for validating
 * `from <= to` before calling (Requirement 3.3/3.4).
 */
export async function getTransactions(
  accountNumber: string,
  range?: { from?: string; to?: string },
  deps: SandboxDeps = {},
): Promise<SandboxResult<Transaction[]>> {
  const params = new URLSearchParams();
  if (range?.from) params.set('from', range.from);
  if (range?.to) params.set('to', range.to);
  const query = params.toString();
  const path =
    `/transactions/accounts/${encodeURIComponent(accountNumber)}` + (query ? `?${query}` : '');
  const result = await sandboxFetch<WireTransaction[]>(path, { method: 'GET' }, {}, deps);
  return mapResult(result, (list) => (Array.isArray(list) ? list.map(mapTransaction) : []));
}

/**
 * Parse a sandbox `Error_Body` for the transfer path, extracting BOTH the
 * machine-readable `error` code and the human `message`. The shared
 * `sandboxFetch`/`normalizeResponse` path deliberately drops `message` for
 * reads (Requirement 6.7), but the `TransferResult` CONFLICT variant requires
 * `error` + `message`, so the transfer path parses the body itself. Nothing
 * secret lives in an `Error_Body`, so forwarding `message` here is safe.
 */
async function parseTransferErrorBody(
  res: Response,
): Promise<{ error?: string; message?: string }> {
  try {
    const body = (await res.clone().json()) as unknown;
    if (body && typeof body === 'object') {
      const b = body as Record<string, unknown>;
      return {
        error: typeof b.error === 'string' ? b.error : undefined,
        message: typeof b.message === 'string' ? b.message : undefined,
      };
    }
  } catch {
    // Non-JSON or empty body -> no extra detail.
  }
  return {};
}

/**
 * Make an internal transfer — `POST /payments/transfers` (Requirement 4.1).
 *
 * Unlike the read wrappers, this does NOT go through `normalizeResponse`:
 * the HTTP outcome is mapped directly to exactly one {@link TransferResult}
 * variant (Requirements 4.3-4.10), which is a different, more specific union
 * than `SandboxResult<T>` and whose CONFLICT case carries both the `error`
 * code and the `message`.
 *
 * Status -> variant mapping:
 *   201 -> COMPLETED
 *   202 -> AML_HELD
 *   422 -> AML_BLOCKED
 *   409 -> CONFLICT (error + message from the `Error_Body`)
 *   403 -> FORBIDDEN
 *   401 -> UNAUTHENTICATED
 *   429 -> RATE_LIMITED
 *   any other status / unparseable -> ERROR (reason UNEXPECTED, with status)
 *   missing credential            -> ERROR (reason UNEXPECTED, no status)
 *   timeout (>30s)                -> ERROR (reason TIMEOUT)
 *   connectivity failure          -> ERROR (reason NETWORK)
 *
 * The 30s transfer timeout is enforced here via `AbortController`, mirroring
 * `sandboxFetch` but keeping the transfer-specific body parsing and union
 * mapping in one place. Credentials are resolved and injected exactly as for
 * reads and never appear in the returned value.
 */
export async function createTransfer(
  body: TransferRequest,
  deps: SandboxDeps = {},
): Promise<TransferResult> {
  const getAccessToken = deps.getAccessToken ?? defaultGetAccessToken;
  const getSandboxConfig = deps.getSandboxConfig ?? defaultGetSandboxConfig;
  const fetchImpl = deps.fetchImpl ?? fetch;

  // 1. Resolve credentials strictly server-side.
  const { sandboxApiBaseUrl, sandboxApiKey } = getSandboxConfig();
  const token = await getAccessToken();

  // 2. Missing credential -> no outbound request. Mirror `sandboxFetch`'s
  //    posture: the caller (BFF) treats a credential-less state as needing
  //    re-authentication; in the TransferResult union that is an ERROR with no
  //    status (there was no HTTP exchange) that the BFF maps to a 401 path.
  if (!token || !sandboxApiKey) {
    return { kind: 'ERROR', reason: 'UNEXPECTED' };
  }

  // 3. Build headers (injects credentials + origin + JSON content type).
  const headers = buildHeaders({
    token,
    apiKey: sandboxApiKey,
    hasBody: true,
    extra: undefined,
  });

  // 4. 30s timeout for transfers (Requirement 4.10).
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TRANSFER_TIMEOUT_MS);

  try {
    const res = await fetchImpl(`${sandboxApiBaseUrl}/payments/transfers`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
      credentials: 'omit',
    });
    return await mapTransferResponse(res);
  } catch (err) {
    // 5. Map failures without leaking secrets.
    if (isAbortError(err)) {
      return { kind: 'ERROR', reason: 'TIMEOUT' };
    }
    return { kind: 'ERROR', reason: 'NETWORK' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Map a transfer {@link Response} to exactly one {@link TransferResult} variant
 * (Requirements 4.3-4.10). Exported for direct unit testing of the mapping.
 * Covered statuses are mutually exclusive; any other status maps to ERROR.
 */
export async function mapTransferResponse(res: Response): Promise<TransferResult> {
  switch (res.status) {
    case 201:
      return { kind: 'COMPLETED', status: 201 };
    case 202:
      return { kind: 'AML_HELD', status: 202 };
    case 422:
      return { kind: 'AML_BLOCKED', status: 422 };
    case 409: {
      const { error, message } = await parseTransferErrorBody(res);
      return {
        kind: 'CONFLICT',
        status: 409,
        error: error ?? 'CONFLICT',
        message: message ?? '',
      };
    }
    case 403:
      return { kind: 'FORBIDDEN', status: 403 };
    case 401:
      return { kind: 'UNAUTHENTICATED', status: 401 };
    case 429:
      return { kind: 'RATE_LIMITED', status: 429 };
    default:
      return { kind: 'ERROR', reason: 'UNEXPECTED', status: res.status };
  }
}
