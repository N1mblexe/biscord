import type { Ack, VoiceStatePayload } from '@hearth/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createVoiceStateSender } from './stateSender';

const LOUNGE = '11111111-1111-4111-8111-111111111111';
const state = (selfMute: boolean): VoiceStatePayload => ({
  channelId: LOUNGE,
  selfMute,
  selfDeaf: false,
  camera: false,
  screen: false,
});
const rateLimited = (retryAfterMs: number): Ack<null> => ({
  ok: false,
  error: { code: 'RATE_LIMITED', message: 'Too many voice state updates', details: { retryAfterMs } },
});

function setup() {
  const emitted: { payload: VoiceStatePayload; ack: (res: Ack<null> | undefined) => void }[] = [];
  const resend = vi.fn();
  const send = createVoiceStateSender(
    {
      connected: () => true,
      emit: (payload, ack) => {
        emitted.push({ payload, ack });
      },
    },
    resend,
  );
  return { send, emitted, resend };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('voice:state sender', () => {
  it('never sends the same payload twice while it awaits its ack', () => {
    const { send, emitted } = setup();
    send(state(true));
    send(state(true));
    expect(emitted).toHaveLength(1);
    emitted[0]?.ack({ ok: true, data: null });
    send(state(true));
    expect(emitted).toHaveLength(2);
  });

  it('a RATE_LIMITED ack re-sends the current state after retryAfterMs, holding sends back meanwhile', () => {
    const { send, emitted, resend } = setup();
    send(state(true));
    emitted[0]?.ack(rateLimited(1200));
    // Refused too if sent now: held back.
    send(state(false));
    expect(emitted).toHaveLength(1);
    vi.advanceTimersByTime(1199);
    expect(resend).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(resend).toHaveBeenCalledTimes(1);
    // The window is over: sending works again.
    send(state(false));
    expect(emitted.map((e) => e.payload.selfMute)).toEqual([true, false]);
  });

  it('other failures (VALIDATION, ack timeout) are not retried', () => {
    const { send, emitted, resend } = setup();
    send(state(true));
    emitted[0]?.ack({ ok: false, error: { code: 'VALIDATION', message: 'not in channel' } });
    send(state(false));
    emitted[1]?.ack(undefined);
    vi.advanceTimersByTime(10_000);
    expect(resend).not.toHaveBeenCalled();
  });
});
