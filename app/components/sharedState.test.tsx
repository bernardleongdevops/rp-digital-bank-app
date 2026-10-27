/**
 * Unit tests for the shared UI state components (task 6.4).
 *
 * Covers the four reusable, accessible presentation components in
 * `app/components`:
 *   - LoadingState      (Requirements 8.1, 8.6)
 *   - EmptyState        (Requirements 8.5, 8.6)
 *   - ErrorState        (Requirements 8.2, 8.3, 8.4, 8.6, 8.7)
 *   - TransferResultBanner (Requirements 4.3-4.10, 8.7)
 *
 * These are `'use client'` components with no server-only imports, so the
 * default jsdom Vitest environment (vitest.setup.ts loads jest-dom) renders
 * them directly. All assertions are accessibility-first: ARIA roles,
 * aria-live/aria-busy hints, accessible names, and keyboard-operable controls.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { LoadingState } from './LoadingState';
import { EmptyState } from './EmptyState';
import { ErrorState } from './ErrorState';
import { TransferResultBanner } from './TransferResultBanner';
import { mapTransferOutcome } from '@/lib/transferPresentation';
import type { TransferResult } from '@/lib/types';

describe('LoadingState (Requirements 8.1, 8.6)', () => {
  it('renders a polite, busy status region with its default label', () => {
    render(<LoadingState />);

    const status = screen.getByRole('status');
    expect(status).toBeInTheDocument();
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).toHaveAttribute('aria-busy', 'true');
    // Default label carries the meaning (not a bare spinner).
    expect(status).toHaveTextContent('Loading…');
  });

  it('renders a custom label as the accessible status text', () => {
    render(<LoadingState label="Loading accounts" />);

    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Loading accounts');
  });
});

describe('EmptyState (Requirements 8.5, 8.6)', () => {
  it('renders the title as the region label and displays it', () => {
    render(<EmptyState title="No accounts" />);

    // The section is labelled by its title so the empty message is discoverable.
    const region = screen.getByRole('region', { name: 'No accounts' });
    expect(region).toBeInTheDocument();
    expect(region).toHaveTextContent('No accounts');
  });

  it('renders the optional description when provided', () => {
    render(
      <EmptyState
        title="No transactions"
        description="There are no transactions in this date range."
      />,
    );

    expect(
      screen.getByText('There are no transactions in this date range.'),
    ).toBeInTheDocument();
  });

  it('renders an optional action beneath the message', () => {
    render(
      <EmptyState title="No accounts" action={<button type="button">Adjust filters</button>} />,
    );

    expect(screen.getByRole('button', { name: 'Adjust filters' })).toBeInTheDocument();
  });
});

describe('ErrorState (Requirements 8.2, 8.3, 8.4, 8.6, 8.7)', () => {
  it('renders an alert region with the provided safe message', () => {
    render(<ErrorState message="We could not load your accounts." />);

    const alert = screen.getByRole('alert');
    expect(alert).toBeInTheDocument();
    expect(alert).toHaveTextContent('We could not load your accounts.');
  });

  it('falls back to a safe generic message when none is provided', () => {
    render(<ErrorState />);

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Something went wrong. Please try again.',
    );
  });

  it('shows a keyboard-operable Retry button that calls onRetry when clicked', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(<ErrorState message="Request failed." onRetry={onRetry} />);

    const retry = screen.getByRole('button', { name: 'Retry' });
    expect(retry).toBeEnabled();

    await user.click(retry);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('invokes onRetry when the button is activated via the keyboard', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(<ErrorState message="Request failed." onRetry={onRetry} />);

    const retry = screen.getByRole('button', { name: 'Retry' });
    retry.focus();
    expect(retry).toHaveFocus();

    await user.keyboard('{Enter}');
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('uses a custom retry label when provided', () => {
    render(<ErrorState onRetry={() => {}} retryLabel="Try again" />);

    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('hides the retry control when no onRetry handler is given', () => {
    render(<ErrorState message="No retry here." />);

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('disables the retry control when canRetry is false (rate-limited, Requirement 8.7)', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(<ErrorState message="Too many requests." onRetry={onRetry} canRetry={false} />);

    const retry = screen.getByRole('button', { name: 'Retry' });
    expect(retry).toBeDisabled();

    // A disabled button does not fire its handler on click.
    await user.click(retry);
    expect(onRetry).not.toHaveBeenCalled();
  });
});

describe('TransferResultBanner — result surface (Requirements 4.3-4.10, 8.7)', () => {
  function renderResult(result: TransferResult, onRetry?: () => void) {
    return render(<TransferResultBanner result={result} onRetry={onRetry} />);
  }

  it('COMPLETED renders a polite status banner with its outcome attribute', () => {
    renderResult({ kind: 'COMPLETED', status: 201 });

    const banner = screen.getByRole('status');
    expect(banner).toHaveAttribute('data-outcome', 'COMPLETED');
    expect(banner).toHaveAttribute('aria-live', 'polite');
    expect(banner).toHaveTextContent('Transfer completed');
  });

  it('AML_HELD (informational) uses role="status"', () => {
    renderResult({ kind: 'AML_HELD', status: 202 });

    const banner = screen.getByRole('status');
    expect(banner).toHaveAttribute('data-outcome', 'AML_HELD');
  });

  it('AML_BLOCKED (warning) uses role="alert"', () => {
    renderResult({ kind: 'AML_BLOCKED', status: 422 });

    const banner = screen.getByRole('alert');
    expect(banner).toHaveAttribute('data-outcome', 'AML_BLOCKED');
  });

  it('CONFLICT shows the error-code-specific message (Requirement 4.6)', () => {
    renderResult({
      kind: 'CONFLICT',
      status: 409,
      error: 'INSUFFICIENT_FUNDS',
      message: 'ignored-upstream-message',
    });

    const banner = screen.getByRole('alert');
    expect(banner).toHaveAttribute('data-outcome', 'CONFLICT');
    expect(banner).toHaveTextContent(
      'The source account does not have enough funds for this transfer.',
    );
  });

  it('FORBIDDEN (error) uses role="alert"', () => {
    renderResult({ kind: 'FORBIDDEN', status: 403 });

    const banner = screen.getByRole('alert');
    expect(banner).toHaveAttribute('data-outcome', 'FORBIDDEN');
  });

  it('RATE_LIMITED shows no enabled retry (Requirements 4.9, 8.7)', () => {
    // Even when an onRetry handler is supplied, the rate-limited outcome must
    // not expose a retry control before a delay.
    renderResult({ kind: 'RATE_LIMITED', status: 429 }, () => {});

    const banner = screen.getByRole('alert');
    expect(banner).toHaveAttribute('data-outcome', 'RATE_LIMITED');
    expect(banner).toHaveTextContent('Too many requests');
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('ERROR shows a Retry button wired to onRetry (Requirement 4.10)', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    renderResult({ kind: 'ERROR', reason: 'NETWORK' }, onRetry);

    const banner = screen.getByRole('alert');
    expect(banner).toHaveAttribute('data-outcome', 'ERROR');

    const retry = screen.getByRole('button', { name: 'Retry' });
    await user.click(retry);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('ERROR hides the retry control when no onRetry handler is provided', () => {
    renderResult({ kind: 'ERROR', reason: 'TIMEOUT' });

    expect(screen.getByRole('alert')).toHaveAttribute('data-outcome', 'ERROR');
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });
});

describe('TransferResultBanner — presentation surface (Requirements 4.3-4.10, 8.7)', () => {
  it('COMPLETED (success) renders role="status" with the outcome attribute', () => {
    render(<TransferResultBanner presentation={mapTransferOutcome({ status: 201 })} />);

    const banner = screen.getByRole('status');
    expect(banner).toHaveAttribute('data-outcome', 'COMPLETED');
    expect(banner).toHaveTextContent('Transfer completed');
  });

  it('AML_HELD (info) renders role="status"', () => {
    render(<TransferResultBanner presentation={mapTransferOutcome({ status: 202 })} />);

    expect(screen.getByRole('status')).toHaveAttribute('data-outcome', 'AML_HELD');
  });

  it('CONFLICT shows the error-code-specific message and uses role="alert" (Requirement 4.6)', () => {
    render(
      <TransferResultBanner
        presentation={mapTransferOutcome({ status: 409, error: 'CURRENCY_MISMATCH' })}
      />,
    );

    const banner = screen.getByRole('alert');
    expect(banner).toHaveAttribute('data-outcome', 'CONFLICT');
    expect(banner).toHaveTextContent(
      'The source and destination accounts use different currencies.',
    );
  });

  it('RATE_LIMITED shows no enabled retry even with an onRetry handler (Requirements 4.9, 8.7)', () => {
    render(
      <TransferResultBanner presentation={mapTransferOutcome({ status: 429 })} onRetry={() => {}} />,
    );

    const banner = screen.getByRole('alert');
    expect(banner).toHaveAttribute('data-outcome', 'RATE_LIMITED');
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('retryable ERROR shows a Retry button wired to onRetry (Requirement 4.10)', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    // status 502 with error NETWORK -> generic retryable NETWORK presentation.
    render(
      <TransferResultBanner
        presentation={mapTransferOutcome({ status: 502, error: 'NETWORK' })}
        onRetry={onRetry}
      />,
    );

    const banner = screen.getByRole('alert');
    expect(banner).toHaveAttribute('data-outcome', 'NETWORK');

    const retry = screen.getByRole('button', { name: 'Retry' });
    await user.click(retry);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('retryable error does not render a retry control when no onRetry handler is provided', () => {
    render(<TransferResultBanner presentation={mapTransferOutcome({ status: 504 })} />);

    const banner = screen.getByRole('alert');
    expect(banner).toHaveAttribute('data-outcome', 'TIMEOUT');
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });
});
