/**
 * Tests for the AI banking-assistant chat widget's transfer-confirmation
 * handshake (Phase 2). Renders <ChatWidget/> in jsdom and drives it through
 * its public behaviour by mocking the browser `fetch` to the single
 * same-origin BFF endpoint it uses, `POST /api/ai/chat`. No request ever
 * reaches the live sandbox or the model provider.
 *
 * Coverage:
 *  - a `confirm_transfer` reply renders a confirmation CARD (not a plain chat
 *    bubble) with Confirm / Cancel and disables the text input;
 *  - clicking Confirm POSTs the confirmation body with `confirmed: true` and
 *    the EXACT token (and no `message`), then renders the outcome message;
 *  - clicking Cancel sends NO confirmed request and shows the cancelled state;
 *  - the opaque confirmationToken never appears in the rendered chat text.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ChatWidget } from './ChatWidget';

/** The opaque confirmation token the backend would issue; must never render. */
const TOKEN = 'ctok_SECRET_abc123';

/** A JSON Response with the given status (default 200). */
function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** One captured POST /api/ai/chat call: its parsed JSON body. */
interface CapturedCall {
  body: {
    message?: string;
    confirmation?: { confirmationToken: string; confirmed: boolean };
    history?: Array<{ role: string; content: string }>;
  };
}

const calls: CapturedCall[] = [];

/** Queue of responders consumed in order, one per POST /api/ai/chat. */
type Responder = () => Response | Promise<Response>;
let responders: Responder[];

function installFetch() {
  calls.length = 0;
  responders = [];
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.includes('/api/ai/chat') && method === 'POST') {
        const parsed = init?.body ? JSON.parse(String(init.body)) : {};
        calls.push({ body: parsed });
        const responder = responders.shift();
        if (!responder) throw new Error('unexpected extra POST /api/ai/chat');
        return responder();
      }
      throw new Error('unexpected fetch: ' + method + ' ' + url);
    },
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** Open the chat panel and return the panel dialog. */
async function openPanel(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /open banking assistant/i }));
  return screen.getByRole('dialog', { name: /banking assistant/i });
}

/** Type a message and press Send. */
async function sendMessage(user: ReturnType<typeof userEvent.setup>, text: string) {
  const input = screen.getByLabelText(/message the banking assistant/i);
  await user.type(input, text);
  await user.click(screen.getByRole('button', { name: /^send$/i }));
}

beforeEach(() => {
  installFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('ChatWidget — transfer confirmation handshake', () => {
  it('renders a confirmation card (not a bubble) and disables the input', async () => {
    const user = userEvent.setup();
    responders = [
      () =>
        jsonResponse({
          type: 'confirm_transfer',
          confirmationToken: TOKEN,
          humanSummary: 'Transfer $200.00 from ACC-1001 to ACC-2002?',
          intent: {
            fromAccount: 'ACC-1001',
            toAccount: 'ACC-2002',
            amount: 200,
            currency: 'SGD',
            description: 'rent',
          },
        }),
    ];

    render(<ChatWidget />);
    await openPanel(user);
    await sendMessage(user, 'transfer 200 to ACC-2002');

    // The confirmation CARD is shown (a labelled group), with Confirm/Cancel.
    const card = await screen.findByTestId('confirm-transfer-card');
    expect(card).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: /^confirm$/i })).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: /^cancel$/i })).toBeInTheDocument();

    // Structured intent fields are rendered.
    expect(screen.getByTestId('confirm-from')).toHaveTextContent('ACC-1001');
    expect(screen.getByTestId('confirm-to')).toHaveTextContent('ACC-2002');
    expect(screen.getByTestId('confirm-amount')).toHaveTextContent(/200/);
    expect(screen.getByTestId('confirm-description')).toHaveTextContent('rent');

    // The text input is disabled while the card is pending.
    expect(screen.getByLabelText(/message the banking assistant/i)).toBeDisabled();

    // The token must NOT appear anywhere in the rendered panel text.
    expect(screen.getByRole('dialog').textContent ?? '').not.toContain(TOKEN);
  });

  it('Confirm POSTs confirmed:true with the exact token (no message) and renders the outcome', async () => {
    const user = userEvent.setup();
    responders = [
      () =>
        jsonResponse({
          type: 'confirm_transfer',
          confirmationToken: TOKEN,
          humanSummary: 'Transfer $200.00 from ACC-1001 to ACC-2002?',
          intent: { fromAccount: 'ACC-1001', toAccount: 'ACC-2002', amount: 200, currency: 'SGD' },
        }),
      () =>
        jsonResponse({
          type: 'message',
          reply: 'Your transfer is complete.',
          transferResult: { outcome: 'COMPLETED' },
        }),
    ];

    render(<ChatWidget />);
    await openPanel(user);
    await sendMessage(user, 'transfer 200 to ACC-2002');

    const card = await screen.findByTestId('confirm-transfer-card');
    await user.click(within(card).getByRole('button', { name: /^confirm$/i }));

    // The outcome message renders as an assistant bubble.
    await screen.findByText(/your transfer is complete/i);

    // Exactly two POSTs: the original message, then the confirmation.
    expect(calls).toHaveLength(2);

    const confirmCall = calls[1];
    expect(confirmCall.body.confirmation).toEqual({
      confirmationToken: TOKEN,
      confirmed: true,
    });
    // The confirmation turn carries NO message.
    expect(confirmCall.body.message).toBeUndefined();
    // History is forwarded and never contains the token.
    expect(JSON.stringify(confirmCall.body.history ?? [])).not.toContain(TOKEN);

    // The card is gone; the input is re-enabled.
    expect(screen.queryByTestId('confirm-transfer-card')).not.toBeInTheDocument();
    expect(screen.getByLabelText(/message the banking assistant/i)).not.toBeDisabled();

    // The token never appears in the rendered chat.
    expect(screen.getByRole('dialog').textContent ?? '').not.toContain(TOKEN);
  });

  it('Cancel sends no confirmed request and shows the cancelled state', async () => {
    const user = userEvent.setup();
    responders = [
      () =>
        jsonResponse({
          type: 'confirm_transfer',
          confirmationToken: TOKEN,
          humanSummary: 'Transfer $200.00 from ACC-1001 to ACC-2002?',
          intent: { fromAccount: 'ACC-1001', toAccount: 'ACC-2002', amount: 200, currency: 'SGD' },
        }),
    ];

    render(<ChatWidget />);
    await openPanel(user);
    await sendMessage(user, 'transfer 200 to ACC-2002');

    const card = await screen.findByTestId('confirm-transfer-card');
    await user.click(within(card).getByRole('button', { name: /^cancel$/i }));

    // A short cancelled bubble is shown and the card is dismissed.
    await screen.findByText(/transfer cancelled/i);
    expect(screen.queryByTestId('confirm-transfer-card')).not.toBeInTheDocument();

    // Only the original message POST happened — NO confirmed request was sent.
    expect(calls).toHaveLength(1);
    expect(calls[0].body.message).toBe('transfer 200 to ACC-2002');
    expect(
      calls.some((c) => c.body.confirmation?.confirmed === true),
    ).toBe(false);

    // Input is usable again after cancelling.
    expect(screen.getByLabelText(/message the banking assistant/i)).not.toBeDisabled();
  });
});
