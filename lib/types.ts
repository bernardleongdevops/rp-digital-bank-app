// Shared data model types for the Customer Banking App.
//
// This module is safe to import from both server and client code. It contains
// only type declarations and literal unions -- no runtime secrets, credentials,
// or gateway/issuer URLs.

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
