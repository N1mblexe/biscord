import { RateLimitedDetails, type Ack, type VoiceStatePayload } from '@hearth/shared';

/** How the sender reaches the server (the engine wraps the socket). */
export interface VoiceStateTransport {
  connected: () => boolean;
  /** Emits `voice:state`; `ack` gets the server's answer, or `undefined` on an ack timeout. */
  emit: (payload: VoiceStatePayload, ack: (res: Ack<null> | undefined) => void) => void;
}

/** Used when a `RATE_LIMITED` ack carries no `retryAfterMs`. */
const DEFAULT_RETRY_MS = 5000;

/**
 * `voice:state` sender: only while the socket is connected (a buffered event would arrive stale;
 * the bootstrap after a reconnect triggers a re-sync instead), and never the same payload twice
 * while one is awaiting its ack.
 *
 * A `RATE_LIMITED` ack (CONTRACTS B.7b rule 7: 20 per 5 s per user) would otherwise leave the
 * server with an older state: after its `retryAfterMs`, `resend` is called to send the state as it
 * is then (the controller's re-sync). Sends in the meantime are held back; they'd be refused too.
 */
export function createVoiceStateSender(
  transport: VoiceStateTransport,
  resend: () => void,
): (payload: VoiceStatePayload) => void {
  let inflight: string | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;

  const scheduleRetry = (res: Ack<null> | undefined) => {
    if (res?.ok !== false || res.error.code !== 'RATE_LIMITED' || retry !== null) return;
    const details = RateLimitedDetails.safeParse(res.error.details);
    retry = setTimeout(
      () => {
        retry = null;
        resend();
      },
      details.success ? details.data.retryAfterMs : DEFAULT_RETRY_MS,
    );
  };

  return (payload) => {
    if (!transport.connected() || retry !== null) return;
    const key = JSON.stringify(payload);
    if (key === inflight) return;
    inflight = key;
    transport.emit(payload, (res) => {
      if (inflight === key) inflight = null;
      scheduleRetry(res);
    });
  };
}
