'use client';

/**
 * AI banking-assistant chat widget (Phase 2 — read + transfer confirmation).
 *
 * A floating circular button fixed at the bottom-right of every authenticated
 * page; clicking it toggles a chat panel with a scrollable message list, a
 * text input, and a send button. All traffic goes to the SAME-ORIGIN local
 * BFF route `/api/ai/chat` (NEVER the sandbox or the model provider directly).
 * The browser never holds the OIDC access token or the Sandbox_Key — those
 * stay server-side in the BFF, exactly like the app's other sandbox calls.
 *
 * Reply rendering by `type`:
 *   - 'message'          -> assistant bubble showing `reply` (and, when a
 *                           post-confirmation outcome carries `transferResult`,
 *                           a succinct outcome line);
 *   - 'error'            -> error-styled bubble showing `reply`;
 *   - 'confirm_transfer' -> a distinct confirmation CARD (not a bubble) showing
 *                           `humanSummary` + the structured `intent` fields and
 *                           Confirm / Cancel buttons. The widget NEVER
 *                           auto-confirms, and the text input is disabled while
 *                           a card is pending so the user must choose.
 *   - anything else      -> render `reply` if present, else a generic message.
 *
 * Transfer-confirmation handshake:
 *   - On a `confirm_transfer` reply the opaque `confirmationToken` is kept in
 *     component state ONLY (never shown in chat text). Confirm POSTs
 *     `{ confirmation: { confirmationToken, confirmed: true }, history }` (no
 *     message) and renders the outcome `message`. Cancel makes NO confirmed
 *     call: it dismisses the card, discards the token, and shows a short
 *     "Transfer cancelled" bubble.
 *
 * Accessibility: the launcher and panel use aria labels; the panel is a
 * labelled dialog; the message list is an aria-live log; focus moves to the
 * input when the panel opens; Escape closes the panel and returns focus to the
 * launcher. Input and send are disabled while a reply is awaited or a
 * confirmation card is pending.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AssistantChatReply,
  AssistantTransferIntent,
  ChatMessage,
  TransferConfirmationDecision,
} from '@/lib/types';

/** Keep the transcript sent upstream to the most recent turns. */
const MAX_HISTORY_TURNS = 10;

/** A rendered transcript entry: a chat turn plus a display variant. */
interface DisplayMessage extends ChatMessage {
  /** 'error' renders the error-styled bubble; otherwise a normal bubble. */
  variant: 'user' | 'assistant' | 'error';
}

/**
 * A pending transfer the assistant proposed and is awaiting the user's
 * decision on. The `token` is the opaque `confirmationToken` from the
 * `confirm_transfer` reply; it lives here in state ONLY and is never rendered
 * into the visible chat text.
 */
interface PendingConfirmation {
  token: string;
  humanSummary: string;
  intent: AssistantTransferIntent;
}

/**
 * Format the structured intent amount for display, tolerating a missing
 * amount/currency (the card still renders the other fields). Never throws.
 */
function formatIntentAmount(intent: AssistantTransferIntent): string {
  if (typeof intent.amount !== 'number' || !Number.isFinite(intent.amount)) {
    return '—';
  }
  const currency = intent.currency ?? '';
  try {
    return new Intl.NumberFormat('en-SG', {
      style: 'currency',
      currency: currency || 'SGD',
    }).format(intent.amount);
  } catch {
    return currency ? intent.amount.toFixed(2) + ' ' + currency : intent.amount.toFixed(2);
  }
}

/** Map a BFF error status/code to safe, user-facing copy (shared by both paths). */
function messageForHttpError(status: number, code: string | undefined): string {
  if (status === 401) {
    return 'Your session has expired. Please sign in again to keep chatting.';
  }
  if (status === 429 || code === 'RATE_LIMITED') {
    return 'Too many requests. Please wait a moment and try again.';
  }
  if (status === 504 || code === 'TIMEOUT') {
    return 'The assistant took too long to respond. Please try again.';
  }
  return 'Sorry, something went wrong reaching the assistant. Please try again.';
}

export function ChatWidget() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [pending, setPending] = useState<PendingConfirmation | null>(null);

  const launcherRef = useRef<HTMLButtonElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  // Move focus into the input when the panel opens (accessibility).
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // Keep the message list scrolled to the newest turn / card.
  useEffect(() => {
    if (open && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [messages, open, sending, pending]);

  const closePanel = useCallback(() => {
    setOpen(false);
    launcherRef.current?.focus();
  }, []);

  const onPanelKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closePanel();
      }
    },
    [closePanel],
  );

  /**
   * Build the upstream history from the current transcript: user/assistant
   * turns only (error bubbles excluded), trimmed to the last ~10 turns. The
   * confirmationToken is NEVER part of any transcript content, so it can never
   * leak into history.
   */
  const buildHistory = useCallback(
    (extra: DisplayMessage[] = []): ChatMessage[] =>
      [...messages, ...extra]
        .filter((m) => m.variant === 'user' || m.variant === 'assistant')
        .map((m) => ({ role: m.role, content: m.content }))
        .slice(-MAX_HISTORY_TURNS),
    [messages],
  );

  /**
   * Apply a successful backend reply to the transcript / pending-card state.
   * Shared by the message-send path and the confirm path so both render
   * replies identically.
   */
  const applyReply = useCallback((data: AssistantChatReply) => {
    const replyText = typeof data.reply === 'string' ? data.reply : '';

    if (data.type === 'confirm_transfer') {
      // Show the proposal as a confirmation CARD (not a bubble). Keep the
      // opaque token in state only. If the backend omitted a token we cannot
      // safely confirm, so fall back to a plain assistant bubble.
      if (typeof data.confirmationToken === 'string' && data.confirmationToken.length > 0) {
        setPending({
          token: data.confirmationToken,
          humanSummary:
            data.humanSummary || replyText || 'Please review this transfer before it is made.',
          intent: data.intent ?? {},
        });
      } else {
        setMessages((prev) => [
          ...prev,
          {
            role: 'assistant',
            content: replyText || 'I could not prepare that transfer. Please try again.',
            variant: 'assistant',
          },
        ]);
      }
      return;
    }

    if (data.type === 'error') {
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: replyText || 'Sorry, I ran into a problem.',
          variant: 'error',
        },
      ]);
      return;
    }

    // 'message' (and any other type) -> an assistant bubble. For a
    // post-confirmation outcome the backend describes the result in `reply`;
    // when a structured `transferResult.outcome` is present we append a
    // succinct outcome line.
    let content = replyText || "I can't do that yet.";
    const outcome = data.transferResult?.outcome;
    if (typeof outcome === 'string' && outcome.length > 0) {
      content = content + '\n\nOutcome: ' + outcome;
    }
    setMessages((prev) => [
      ...prev,
      { role: 'assistant', content, variant: 'assistant' },
    ]);
  }, []);

  /**
   * POST one turn to the BFF and render the outcome. `body` is either a
   * message turn `{ message, history }` or a confirmation turn
   * `{ confirmation, history }`. Transport/HTTP errors render an error bubble
   * using the shared status->copy mapping (401 re-auth, 429 back-off,
   * 5xx/timeout). Returns nothing; all effects are state updates.
   */
  const postTurn = useCallback(
    async (body: {
      message?: string;
      confirmation?: TransferConfirmationDecision;
      history: ChatMessage[];
    }) => {
      setSending(true);
      try {
        const res = await fetch('/api/ai/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify(body),
        });

        if (!res.ok) {
          let code: string | undefined;
          try {
            const errBody = (await res.json()) as { error?: string };
            code = errBody?.error;
          } catch {
            // Non-JSON error body; fall back to the status alone.
          }
          setMessages((prev) => [
            ...prev,
            {
              role: 'assistant',
              content: messageForHttpError(res.status, code),
              variant: 'error',
            },
          ]);
          return;
        }

        const data = (await res.json()) as AssistantChatReply;
        applyReply(data);
      } catch {
        setMessages((prev) => [
          ...prev,
          {
            role: 'assistant',
            content:
              'We could not reach the assistant. Check your connection and try again.',
            variant: 'error',
          },
        ]);
      } finally {
        setSending(false);
      }
    },
    [applyReply],
  );

  /** Send the typed message as a normal chat turn. */
  const send = useCallback(async () => {
    const text = input.trim();
    // Guard: no empty sends, none while awaiting a reply, and none while a
    // confirmation card is pending (the user must Confirm/Cancel first).
    if (text.length === 0 || sending || pending) return;

    const userTurn: DisplayMessage = { role: 'user', content: text, variant: 'user' };
    const history = buildHistory([userTurn]);

    // Optimistically show the user's turn and clear the input.
    setMessages((prev) => [...prev, userTurn]);
    setInput('');

    await postTurn({ message: text, history });
  }, [input, sending, pending, buildHistory, postTurn]);

  /** Confirm the pending transfer: POST confirmed:true with the opaque token. */
  const confirmTransfer = useCallback(async () => {
    if (!pending || sending) return;
    const token = pending.token;
    const summary = pending.humanSummary;

    // Record the decision in the visible transcript WITHOUT the token, so
    // follow-up questions have context but the token never appears in chat.
    const decisionTurn: DisplayMessage = {
      role: 'user',
      content: 'Yes, confirm the transfer.',
      variant: 'user',
    };
    // History carries the proposal summary (as an assistant turn) + the user's
    // confirmation, so the backend/model keep context.
    const history = buildHistory([
      { role: 'assistant', content: summary, variant: 'assistant' },
      decisionTurn,
    ]);

    // Dismiss the card and show the user's decision bubble.
    setPending(null);
    setMessages((prev) => [...prev, decisionTurn]);

    await postTurn({
      confirmation: { confirmationToken: token, confirmed: true },
      history,
    });
  }, [pending, sending, buildHistory, postTurn]);

  /**
   * Cancel the pending transfer locally: make NO confirmed call, discard the
   * token, dismiss the card, and show a short cancelled bubble. (The backend
   * treats a non-confirmed decision as a no-op, so a server round-trip is
   * unnecessary.)
   */
  const cancelTransfer = useCallback(() => {
    if (!pending) return;
    setPending(null);
    setMessages((prev) => [
      ...prev,
      { role: 'assistant', content: 'Transfer cancelled.', variant: 'assistant' },
    ]);
    inputRef.current?.focus();
  }, [pending]);

  const onInputKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        void send();
      }
    },
    [send],
  );

  // The text input is disabled while a reply is in flight OR a confirmation
  // card is pending (the user must choose Confirm/Cancel first).
  const inputDisabled = sending || pending !== null;

  return (
    <>
      {/* Floating launcher — fixed bottom-right. */}
      <button
        ref={launcherRef}
        type="button"
        className="chat-launcher"
        aria-label={open ? 'Close banking assistant' : 'Open banking assistant'}
        aria-expanded={open}
        aria-controls="chat-panel"
        onClick={() => setOpen((v) => !v)}
      >
        <span aria-hidden="true">{open ? '\u2715' : '\uD83D\uDCAC'}</span>
      </button>

      {open ? (
        <div
          id="chat-panel"
          className="chat-panel"
          role="dialog"
          aria-label="Banking assistant"
          aria-modal="false"
          onKeyDown={onPanelKeyDown}
        >
          <div className="chat-panel-header">
            <h2 className="chat-panel-title">Banking assistant</h2>
            <button
              type="button"
              className="chat-close"
              aria-label="Close banking assistant"
              onClick={closePanel}
            >
              <span aria-hidden="true">✕</span>
            </button>
          </div>

          <div
            ref={listRef}
            className="chat-messages"
            role="log"
            aria-live="polite"
            aria-label="Conversation"
          >
            {messages.length === 0 && !pending ? (
              <p className="chat-empty" role="status">
                Hi! Ask me about your accounts, balances, or recent transactions.
              </p>
            ) : (
              messages.map((m, i) => (
                <div
                  key={i}
                  className={
                    'chat-bubble ' +
                    (m.variant === 'user'
                      ? 'chat-bubble-user'
                      : m.variant === 'error'
                        ? 'chat-bubble-error'
                        : 'chat-bubble-assistant')
                  }
                >
                  <span className="chat-bubble-role">
                    {m.variant === 'user' ? 'You' : 'Assistant'}
                  </span>
                  <span>{m.content}</span>
                </div>
              ))
            )}

            {/* Transfer confirmation card (distinct from a chat bubble). */}
            {pending ? (
              <div
                className="chat-confirm-card"
                role="group"
                aria-label="Confirm transfer"
                data-testid="confirm-transfer-card"
              >
                <p className="chat-confirm-title">Confirm transfer</p>
                <p className="chat-confirm-summary">{pending.humanSummary}</p>
                <dl className="chat-confirm-details">
                  <div>
                    <dt>From</dt>
                    <dd data-testid="confirm-from">{pending.intent.fromAccount ?? '—'}</dd>
                  </div>
                  <div>
                    <dt>To</dt>
                    <dd data-testid="confirm-to">{pending.intent.toAccount ?? '—'}</dd>
                  </div>
                  <div>
                    <dt>Amount</dt>
                    <dd data-testid="confirm-amount">{formatIntentAmount(pending.intent)}</dd>
                  </div>
                  {pending.intent.description ? (
                    <div>
                      <dt>Description</dt>
                      <dd data-testid="confirm-description">{pending.intent.description}</dd>
                    </div>
                  ) : null}
                </dl>
                <div className="chat-confirm-actions">
                  <button
                    type="button"
                    className="chat-confirm-yes"
                    onClick={() => void confirmTransfer()}
                    disabled={sending}
                  >
                    {sending ? 'Confirming…' : 'Confirm'}
                  </button>
                  <button
                    type="button"
                    className="chat-confirm-no"
                    onClick={cancelTransfer}
                    disabled={sending}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : null}

            {sending ? (
              <div className="chat-bubble chat-bubble-assistant" aria-hidden="true">
                <span className="chat-bubble-role">Assistant</span>
                <span className="chat-typing">Thinking…</span>
              </div>
            ) : null}
          </div>

          <form
            className="chat-input-row"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <label htmlFor="chat-input" className="sr-only">
              Message the banking assistant
            </label>
            <input
              id="chat-input"
              ref={inputRef}
              className="chat-input"
              type="text"
              autoComplete="off"
              placeholder={
                pending ? 'Choose Confirm or Cancel above…' : 'Ask about your accounts…'
              }
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onInputKeyDown}
              disabled={inputDisabled}
              aria-busy={sending}
            />
            <button
              type="submit"
              className="chat-send"
              disabled={inputDisabled || input.trim().length === 0}
            >
              {sending ? 'Sending…' : 'Send'}
            </button>
          </form>
        </div>
      ) : null}
    </>
  );
}
