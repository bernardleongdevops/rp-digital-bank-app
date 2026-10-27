'use client';

/**
 * Transfer outcome banner (Requirements 4.3-4.10, 8.7).
 *
 * Renders a visually distinct, accessible state for each variant of the
 * `TransferResult` discriminated union produced by the transfer outcome mapper
 * (task 6.1). Each outcome gets its own message and visual treatment:
 *
 *   COMPLETED (201)    -> success confirmation
 *   AML_HELD (202)     -> held for anti-money-laundering review
 *   AML_BLOCKED (422)  -> blocked by AML controls
 *   CONFLICT (409)     -> message reflects the `error` code (Requirement 4.6)
 *   FORBIDDEN (403)    -> not the owner of the source account
 *   UNAUTHENTICATED    -> handled by the caller (routes to re-auth); shown as a
 *                         fallback message if rendered
 *   RATE_LIMITED (429) -> rate-limited; NO automatic retry before a delay
 *                         (Requirements 4.9, 8.7)
 *   ERROR              -> generic error (network / timeout / unexpected) with a
 *                         retry action (Requirement 4.10)
 *
 * Security: renders only curated, user-facing copy. The CONFLICT variant shows
 * the upstream machine-readable `error` code mapped to a friendly phrase; no
 * secrets, tokens, or raw upstream bodies are ever rendered. Purely
 * presentational -- no server-only imports.
 *
 * Accessibility: successful / informational outcomes use `role="status"` with
 * `aria-live="polite"`; failure outcomes use `role="alert"` so they are
 * announced immediately. The retry control (ERROR) and the rate-limit control
 * are real keyboard-operable buttons.
 *
 * Two input surfaces (task 9.2): the banner accepts EITHER a `TransferResult`
 * discriminated-union value (`result`) OR the richer `TransferPresentation`
 * produced by `mapTransferOutcome` (`presentation`). The presentation surface
 * is preferred by the Transfer container because it is driven directly from the
 * BFF response `{ status, error?, message? }` and already carries the resolved
 * severity/title/message plus the `canRetry`/`isRateLimit` affordances, so the
 * banner does not re-derive copy. The legacy `result` surface is retained for
 * existing/`TransferResult`-based callers and tests.
 */

import type { TransferResult } from '@/lib/types';
import type { TransferPresentation } from '@/lib/transferPresentation';

export type TransferResultBannerProps = {
  /** Re-initiates the transfer. Used by the ERROR outcome (Requirement 4.10). */
  onRetry?: () => void;
  className?: string;
} & (
  | {
      /** Legacy surface: a `TransferResult` discriminated-union value. */
      result: TransferResult;
      presentation?: never;
    }
  | {
      /** Preferred surface: the mapper's resolved presentation model (9.2). */
      presentation: TransferPresentation;
      result?: never;
    }
);

/** Severity drives the ARIA role: informational vs. error. */
type Severity = 'success' | 'info' | 'warn' | 'error';

interface BannerContent {
  severity: Severity;
  title: string;
  message: string;
}

/** Map a 409 CONFLICT `error` code to a safe, human-readable phrase (Requirement 4.6). */
function conflictMessage(code: string): string {
  switch (code) {
    case 'INSUFFICIENT_FUNDS':
      return 'The source account does not have enough funds for this transfer.';
    case 'SAME_ACCOUNT':
      return 'The source and destination accounts must be different.';
    case 'CURRENCY_MISMATCH':
      return 'The source and destination accounts use different currencies.';
    case 'INVALID_AMOUNT':
      return 'The transfer amount is not valid.';
    default:
      // Unknown code: fall back to generic copy without echoing raw detail.
      return 'The transfer could not be completed due to a conflict.';
  }
}

function contentFor(result: TransferResult): BannerContent {
  switch (result.kind) {
    case 'COMPLETED':
      return {
        severity: 'success',
        title: 'Transfer completed',
        message: 'Your transfer has been completed.',
      };
    case 'AML_HELD':
      return {
        severity: 'info',
        title: 'Transfer held for review',
        message: 'Your transfer is held for anti-money-laundering review.',
      };
    case 'AML_BLOCKED':
      return {
        severity: 'warn',
        title: 'Transfer blocked',
        message: 'Your transfer was blocked by anti-money-laundering controls.',
      };
    case 'CONFLICT':
      return {
        severity: 'warn',
        title: 'Transfer could not be completed',
        message: conflictMessage(result.error),
      };
    case 'FORBIDDEN':
      return {
        severity: 'error',
        title: 'Not permitted',
        message: 'You are not the owner of the source account.',
      };
    case 'UNAUTHENTICATED':
      return {
        severity: 'error',
        title: 'Session expired',
        message: 'Your session is no longer valid. Please sign in again.',
      };
    case 'RATE_LIMITED':
      return {
        severity: 'warn',
        title: 'Too many requests',
        message: 'You have made too many requests. Please wait a moment before retrying.',
      };
    case 'ERROR':
      return {
        severity: 'error',
        title: 'Transfer failed',
        message: 'Something went wrong while processing your transfer. Please try again.',
      };
  }
}

/**
 * Project a `TransferPresentation` (from `mapTransferOutcome`) onto the banner's
 * internal `BannerContent` + outcome discriminator. The presentation already
 * resolved the copy and a four-value severity; `warning` collapses to the
 * banner's `warn` family so the ARIA role stays consistent with the legacy path.
 */
function fromPresentation(presentation: TransferPresentation): {
  content: BannerContent;
  outcome: string;
  showRetry: boolean;
} {
  const severity: Severity =
    presentation.severity === 'warning' ? 'warn' : presentation.severity;
  return {
    content: {
      severity,
      title: presentation.title,
      message: presentation.message,
    },
    outcome: presentation.kind,
    // A retry control is offered only for retryable, non-rate-limited outcomes
    // (the generic transport errors). RATE_LIMITED must not expose an enabled
    // retry before a delay (Requirements 4.9, 4.10, 8.7).
    showRetry: presentation.canRetry && !presentation.isRateLimit,
  };
}

export function TransferResultBanner(props: TransferResultBannerProps) {
  const { onRetry, className } = props;

  // Resolve from whichever surface the caller supplied. The preferred
  // `presentation` surface carries its own retry affordance; the legacy
  // `result` surface offers retry only for the generic ERROR outcome.
  const resolved =
    props.presentation !== undefined
      ? fromPresentation(props.presentation)
      : {
          content: contentFor(props.result),
          outcome: props.result.kind,
          showRetry: props.result.kind === 'ERROR',
        };

  const { content, outcome } = resolved;
  const isError = content.severity === 'error' || content.severity === 'warn';

  // Only expose the retry button when this outcome allows it AND a handler was
  // provided (Requirements 4.9, 4.10, 8.7).
  const showRetry = resolved.showRetry && typeof onRetry === 'function';

  return (
    <div
      className={className}
      role={isError ? 'alert' : 'status'}
      aria-live={isError ? 'assertive' : 'polite'}
      data-outcome={outcome}
    >
      <p>
        <strong>{content.title}</strong>
      </p>
      <p>{content.message}</p>
      {showRetry ? (
        <button type="button" onClick={onRetry}>
          Retry
        </button>
      ) : null}
    </div>
  );
}
