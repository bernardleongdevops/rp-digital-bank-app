// Shared data model types for the Customer Banking App.
//
// This module is safe to import from both server and client code. It contains
// only type declarations and literal unions -- no runtime secrets, credentials,
// or gateway/issuer URLs.

// `TransferOutcomeInput` is imported as a *type only* from the pure, framework-
// free `transferPresentation` module (no server-only imports, no secrets) so
// the scheduled-transfer `lastOutcome` projects onto the same outcome surface
// as the Transfer_Form, keeping a single source of truth for transfer-outcome
// presentation (Requirement 6.7) without introducing server/client coupling.
import type { TransferOutcomeInput } from './transferPresentation';

// --- Customer ---
//
// These are the app's internal (domain) shapes. The sandbox wire format uses
// different field names (e.g. `fullName`, `accountType`, `transactionRef`,
// `bookedAt`); the `sandboxClient` maps the wire response onto these types at
// the BFF boundary so the UI and the rest of the app depend only on this
// stable shape.
export interface CustomerProfile {
  phone?: string;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  postalCode?: string;
  country?: string;
  dateOfBirth?: string;
  occupation?: string;
  preferredChannel?: string;
}

export interface Customer {
  customerRef: string; // e.g. "CUST-ALICE"
  name: string; // display name, e.g. "Alice Tan" (wire: `fullName`)
  email?: string;
  nationalId?: string;
  kycStatus?: string; // e.g. "APPROVED"
  profile?: CustomerProfile;
}

// --- Account ---
export type AccountType = 'SAVINGS' | 'CURRENT';

export interface Account {
  accountNumber: string; // e.g. "ACC-1001"
  type: AccountType; // "SAVINGS" | "CURRENT" (wire: `accountType`)
  balance: number; // e.g. 5000.00
  currency: string; // e.g. "SGD"
  status?: string; // e.g. "ACTIVE"
}

// --- Transaction ---
export type TransactionDirection = 'CREDIT' | 'DEBIT';

export interface Transaction {
  id: string; // wire: `transactionRef`
  timestamp: string; // ISO 8601 (wire: `bookedAt`)
  amount: number; // absolute value
  direction: TransactionDirection; // sign of the movement
  description: string;
  counterparty?: string; // other account, when available
  runningBalance?: number; // balance after the entry, when available
}

// --- Transfer request (body sent to POST /payments/transfers) ---
export interface TransferRequest {
  fromAccount: string; // e.g. "ACC-1001"
  toAccount: string; // e.g. "ACC-1002"
  amount: number; // 0.01 .. 999,999,999.99, max 2 decimals
  description: string; // 0..140 chars
}

// --- Sandbox error body (section 5 of the integration contract) ---
export interface ErrorBody {
  timestamp: string;
  status: number;
  error: string; // machine-readable code, e.g. "INSUFFICIENT_FUNDS"
  message: string;
  path: string;
}

// --- Transfer result: discriminated union keyed by outcome ---
export type TransferResult =
  | { kind: 'COMPLETED'; status: 201 } // success
  | { kind: 'AML_HELD'; status: 202 } // held for review
  | { kind: 'AML_BLOCKED'; status: 422 } // blocked
  | { kind: 'CONFLICT'; status: 409; error: string; message: string } // INSUFFICIENT_FUNDS | SAME_ACCOUNT | CURRENCY_MISMATCH | INVALID_AMOUNT
  | { kind: 'FORBIDDEN'; status: 403 } // not owner of source account
  | { kind: 'UNAUTHENTICATED'; status: 401 } // re-authenticate
  | { kind: 'RATE_LIMITED'; status: 429 } // rate limited, retry after delay
  | { kind: 'ERROR'; reason: 'NETWORK' | 'TIMEOUT' | 'UNEXPECTED'; status?: number };

// --- Generic result for read endpoints ---
export type SandboxResult<T> =
  | { kind: 'OK'; data: T }
  | { kind: 'UNAUTHENTICATED' }
  | { kind: 'RATE_LIMITED' }
  | {
      kind: 'ERROR';
      reason: 'NETWORK' | 'TIMEOUT' | 'UNEXPECTED' | 'HTTP';
      status?: number;
      error?: string;
    };

// ===========================================================================
// Banking App Realism — client-side realism domain types.
//
// These extend the v1 model with the shapes the new views and BFF routes need
// (account open/close, saved payees, scheduled/recurring transfers, profile
// update). Like everything above, they are plain type declarations safe for
// both server and client, carry no secrets, and reuse the existing
// `AccountType`, `CustomerProfile`, and `TransferOutcomeInput` types as the
// single source of truth. The sandbox wire format uses different field names
// (noted per field below); the `sandboxClient` maps the wire response onto
// these types at the BFF boundary.
// ===========================================================================

// --- Account management ---

// Body for POST /api/bff/accounts -> POST /accounts (Requirements 3.1, 3.2).
export interface OpenAccountRequest {
  type: AccountType; // "SAVINGS" | "CURRENT" -- validated against the accepted set
  currency: string; // required, non-empty
}

// --- Saved payees (Requirement 5) ---

export interface Payee {
  id: string; // backend-assigned identifier (wire: `payeeId` / `id`)
  label: string; // human-readable label
  destinationAccount: string; // account number used to pre-fill "To account"
}

// Body for POST /api/bff/payees -> POST /payees (Requirements 5.1, 5.2).
export interface CreatePayeeRequest {
  label: string;
  destinationAccount: string;
}

// --- Scheduled & recurring transfers (Requirement 6) ---

// Supported recurrence set, including the one-off option (Requirement 6.1).
export type Recurrence = 'ONCE' | 'DAILY' | 'WEEKLY' | 'MONTHLY';

// Lifecycle state reported by the gateway (Requirement 6.5).
export type ScheduledTransferStatus = 'SCHEDULED' | 'EXECUTED' | 'FAILED' | 'CANCELLED';

export interface ScheduledTransfer {
  id: string; // wire: `scheduledTransferRef` / `id`
  fromAccount: string;
  toAccount: string;
  amount: number;
  description: string;
  scheduleDate: string; // ISO 8601 date of the next/only execution
  recurrence: Recurrence;
  status: ScheduledTransferStatus;
  // Present once the transfer has executed through the backend payment path.
  // Projected onto the same outcome surface as the Transfer_Form so AML
  // held/blocked render identically (Requirement 6.7).
  lastOutcome?: TransferOutcomeInput; // { status, error?, message? }
}

// Body for POST /api/bff/scheduled-transfers -> POST /payments/scheduled-transfers
// (Requirement 6.1).
export interface ScheduledTransferRequest {
  fromAccount: string;
  toAccount: string;
  amount: number;
  description: string;
  scheduleDate: string; // ISO 8601 date (strictly after today)
  recurrence: Recurrence;
}

// --- Profile update (Requirement 7, only where supported) ---

// Partial, client-validated editable fields for PATCH /customers/me
// (Requirement 7.8). Reuses `CustomerProfile` so the editable set stays in
// lock-step with the profile shape returned by the gateway.
export type CustomerProfileUpdate = Partial<
  Pick<
    CustomerProfile,
    | 'phone'
    | 'addressLine1'
    | 'addressLine2'
    | 'city'
    | 'postalCode'
    | 'country'
    | 'occupation'
    | 'preferredChannel'
  >
>;


// ===========================================================================
// AI banking assistant (chat) — Phase 1 (read-only).
//
// The AI itself lives in the bank backend's `ai-assistant-service`, reached
// through the sandbox gateway at `POST {SANDBOX_API_BASE_URL}/ai/chat`. This
// app NEVER calls the model provider and holds no model-provider key; it only
// proxies chat turns through the server-side BFF (exactly like `/accounts`),
// keeping the OIDC access token and Sandbox_Key server-side. These are plain
// type declarations, safe for both server and client, carrying no secrets.
// ===========================================================================

// One turn in the chat transcript. `user` turns are typed by the customer;
// `assistant` turns are replies from the backend assistant.
export type ChatRole = 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

// A confirm/deny decision the browser sends back to continue a transfer the
// assistant proposed. The `confirmationToken` is the opaque token echoed from
// a prior `confirm_transfer` reply; it is NEVER shown in the visible chat and
// is forwarded verbatim through the BFF. `confirmed` true continues the
// transfer; a non-`confirmed` decision is a no-op server-side.
export interface TransferConfirmationDecision {
  confirmationToken: string;
  confirmed: boolean;
}

// Body the browser sends to `POST /api/ai/chat` (and that the BFF forwards to
// the backend). A turn carries EITHER a `message` (a typed question or
// transfer request) OR a `confirmation` decision continuing a proposed
// transfer — at least one must be present. `history` is the prior turns held
// in the widget's state, trimmed to the most recent few. `confirmation` is
// forwarded verbatim when present.
export interface AssistantChatRequest {
  message?: string;
  history: ChatMessage[];
  confirmation?: TransferConfirmationDecision;
}

// The structured transfer the assistant proposes in a `confirm_transfer`
// reply, rendered as a confirmation card (not a chat bubble). All fields come
// from the backend; the widget treats them as display-only.
export interface AssistantTransferIntent {
  fromAccount?: string;
  toAccount?: string;
  amount?: number;
  currency?: string;
  description?: string;
}

// Discriminator for the backend reply. The widget renders `message` and
// `error` as bubbles and `confirm_transfer` as a confirmation card; any other
// value falls back to `reply` without building new UI.
export type AssistantReplyType = 'message' | 'error' | 'confirm_transfer' | (string & {});

// The backend's `/ai/chat` reply shape. `type` + `reply` drive the bubble
// path; a `confirm_transfer` reply additionally carries the `intent`,
// `confirmationToken`, and `humanSummary`. An outcome turn may carry a
// `transferResult`. Unknown extra fields are tolerated and ignored.
export interface AssistantChatReply {
  type: AssistantReplyType;
  reply?: string;
  // Present on a `confirm_transfer` reply:
  intent?: AssistantTransferIntent;
  confirmationToken?: string;
  humanSummary?: string;
  // Present on a post-confirmation outcome `message` reply:
  transferResult?: {
    status?: number;
    outcome?: string;
    error?: string;
    message?: string;
    [extra: string]: unknown;
  };
  [extra: string]: unknown;
}

// Typed outcome of the server-side `chatWithAssistant` call, mirroring the
// `TransferResult` union style: a successful turn carries the backend reply
// (+ its HTTP status), while every failure maps to a browser-safe variant the
// BFF route turns into the app's standard error responses. No secret ever
// appears in any variant.
export type AssistantChatResult =
  | { kind: 'OK'; status: number; reply: AssistantChatReply }
  | { kind: 'UNAUTHENTICATED' }
  | { kind: 'RATE_LIMITED' }
  | { kind: 'ERROR'; reason: 'NETWORK' | 'TIMEOUT' | 'UNEXPECTED' | 'HTTP'; status?: number };
