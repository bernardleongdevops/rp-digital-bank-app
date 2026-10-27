'use client';

/**
 * Transfer_Form client component (task 9.1, Requirement 5).
 *
 * Renders the money-transfer form with fields `fromAccount`, `toAccount`,
 * `amount`, and `description`, and performs FULL client-side validation BEFORE
 * any request is sent (Requirement 5.1-5.6). The source account is chosen from
 * the customer's own accounts, populated from the BFF (`GET /api/bff/accounts`)
 * so the "source must be owned" rule can be enforced client-side.
 *
 * Scope boundary: this task builds the form, its state, the validation logic
 * (delegated to the pure, exported `validateTransferForm`), and the account
 * selection. The actual submission (`POST /api/bff/transfers`), the in-flight
 * submit-disable guard, and outcome rendering via `TransferResultBanner` are
 * task 9.2. A clear seam is left for that: an optional `onValidSubmit` prop is
 * invoked with the validated values; when it is absent the submit is a no-op
 * (the form still runs validation and blocks invalid input). The component
 * only ever talks to same-origin `/api/bff/*`, never the sandbox directly.
 *
 * Accessibility: each field has an associated `<label>`; a field with an error
 * sets `aria-invalid` and `aria-describedby` pointing at an inline
 * `role="alert"` message so assistive technology announces it. The account
 * list has its own loading / error / empty states (reusing the shared
 * components) so the form degrades gracefully when accounts cannot be loaded.
 */

import { useCallback, useEffect, useState } from 'react';
import type { Account } from '@/lib/types';
import { LoadingState } from '@/app/components/LoadingState';
import { ErrorState } from '@/app/components/ErrorState';
import {
  MAX_DESCRIPTION_LENGTH,
  validateTransferForm,
  type TransferFormErrors,
  type TransferFormValues,
} from '@/lib/transferValidation';

/** Loading lifecycle for the owned-accounts list used by the source selector. */
type AccountsState =
  | { status: 'loading' }
  | { status: 'ready'; accounts: Account[] }
  | { status: 'error' };

const EMPTY_VALUES: TransferFormValues = {
  fromAccount: '',
  toAccount: '',
  amount: '',
  description: '',
};

export interface TransferFormProps {
  /**
   * Seam for task 9.2. Invoked with the validated form values only after every
   * client-side rule passes. Task 9.1 leaves this optional; when omitted a
   * valid submission is a no-op (validation still runs and blocks invalid
   * input). Task 9.2 will supply a handler that POSTs to `/api/bff/transfers`.
   */
  onValidSubmit?: (values: TransferFormValues) => void;
  /** True while a submission started by `onValidSubmit` is in flight (9.2). */
  submitting?: boolean;
}

export function TransferForm({ onValidSubmit, submitting = false }: TransferFormProps) {
  const [accountsState, setAccountsState] = useState<AccountsState>({ status: 'loading' });
  const [values, setValues] = useState<TransferFormValues>(EMPTY_VALUES);
  const [errors, setErrors] = useState<TransferFormErrors>({});
  // Whether a submit has been attempted; after the first attempt we re-validate
  // live on edit so the customer sees errors clear as they fix them.
  const [attempted, setAttempted] = useState(false);

  /**
   * Load the customer's owned accounts from the BFF (same-origin, never the
   * gateway). Extracted so the error state's retry can re-run it.
   */
  const loadAccounts = useCallback(async () => {
    setAccountsState({ status: 'loading' });
    try {
      const res = await fetch('/api/bff/accounts', {
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) {
        setAccountsState({ status: 'error' });
        return;
      }
      const data = (await res.json()) as Account[];
      setAccountsState({ status: 'ready', accounts: Array.isArray(data) ? data : [] });
    } catch {
      setAccountsState({ status: 'error' });
    }
  }, []);

  useEffect(() => {
    void loadAccounts();
  }, [loadAccounts]);

  const ownedAccounts =
    accountsState.status === 'ready' ? accountsState.accounts : undefined;

  /** Update one field, and re-validate live once a submit has been attempted. */
  const setField = useCallback(
    <K extends keyof TransferFormValues>(field: K, value: TransferFormValues[K]) => {
      setValues((prev) => {
        const next = { ...prev, [field]: value };
        if (attempted) {
          setErrors(validateTransferForm(next, ownedAccounts));
        }
        return next;
      });
    },
    [attempted, ownedAccounts],
  );

  const handleSubmit = useCallback(
    (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setAttempted(true);

      const nextErrors = validateTransferForm(values, ownedAccounts);
      setErrors(nextErrors);

      // Any violation: show field-level errors and DO NOT send the request
      // (Requirement 5.1-5.6).
      if (Object.keys(nextErrors).length > 0) return;

      // Valid: hand off to the submission seam (task 9.2). When no handler is
      // wired yet, this is intentionally a no-op.
      onValidSubmit?.(values);
    },
    [values, ownedAccounts, onValidSubmit],
  );

  const descriptionLength = values.description.length;

  return (
    <form onSubmit={handleSubmit} noValidate aria-label="Transfer money">
      {/* Source account — chosen from the customer's own accounts. */}
      <div>
        <label htmlFor="transfer-from">From account</label>
        {accountsState.status === 'loading' ? (
          <LoadingState label="Loading your accounts…" />
        ) : accountsState.status === 'error' ? (
          <ErrorState
            message="We couldn't load your accounts. Please try again."
            onRetry={() => void loadAccounts()}
          />
        ) : accountsState.accounts.length === 0 ? (
          <p role="status">You have no accounts available to transfer from.</p>
        ) : (
          <select
            id="transfer-from"
            name="fromAccount"
            value={values.fromAccount}
            onChange={(e) => setField('fromAccount', e.target.value)}
            disabled={submitting}
            aria-invalid={errors.fromAccount ? true : undefined}
            aria-describedby={errors.fromAccount ? 'transfer-from-error' : undefined}
          >
            <option value="">Select a source account</option>
            {accountsState.accounts.map((account) => (
              <option key={account.accountNumber} value={account.accountNumber}>
                {account.accountNumber} · {account.type} · {account.currency}{' '}
                {account.balance.toFixed(2)}
              </option>
            ))}
          </select>
        )}
        {errors.fromAccount ? (
          <p id="transfer-from-error" role="alert">
            {errors.fromAccount}
          </p>
        ) : null}
      </div>

      {/* Destination account — free-text entry. */}
      <div>
        <label htmlFor="transfer-to">To account</label>
        <input
          id="transfer-to"
          name="toAccount"
          type="text"
          inputMode="text"
          autoComplete="off"
          value={values.toAccount}
          onChange={(e) => setField('toAccount', e.target.value)}
          disabled={submitting}
          aria-invalid={errors.toAccount ? true : undefined}
          aria-describedby={errors.toAccount ? 'transfer-to-error' : undefined}
        />
        {errors.toAccount ? (
          <p id="transfer-to-error" role="alert">
            {errors.toAccount}
          </p>
        ) : null}
      </div>

      {/* Amount — validated as typed text (numeric, > 0, in range, <=2 dp). */}
      <div>
        <label htmlFor="transfer-amount">Amount</label>
        <input
          id="transfer-amount"
          name="amount"
          type="text"
          inputMode="decimal"
          autoComplete="off"
          value={values.amount}
          onChange={(e) => setField('amount', e.target.value)}
          disabled={submitting}
          aria-invalid={errors.amount ? true : undefined}
          aria-describedby={errors.amount ? 'transfer-amount-error' : undefined}
        />
        {errors.amount ? (
          <p id="transfer-amount-error" role="alert">
            {errors.amount}
          </p>
        ) : null}
      </div>

      {/* Description — optional, 0..140 chars. */}
      <div>
        <label htmlFor="transfer-description">Description (optional)</label>
        <textarea
          id="transfer-description"
          name="description"
          value={values.description}
          onChange={(e) => setField('description', e.target.value)}
          disabled={submitting}
          aria-invalid={errors.description ? true : undefined}
          aria-describedby={
            errors.description ? 'transfer-description-error' : 'transfer-description-hint'
          }
        />
        <p id="transfer-description-hint">
          {descriptionLength}/{MAX_DESCRIPTION_LENGTH}
        </p>
        {errors.description ? (
          <p id="transfer-description-error" role="alert">
            {errors.description}
          </p>
        ) : null}
      </div>

      <button type="submit" disabled={submitting}>
        {submitting ? 'Sending…' : 'Send transfer'}
      </button>
    </form>
  );
}
