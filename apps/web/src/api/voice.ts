import { VoiceTokenResponse } from '@hearth/shared';
import { apiFetch } from './client';

/** POST /voice/:channelId/token (row 29): a 10-minute LiveKit token for the channel's room. */
export function fetchVoiceToken(channelId: string, signal?: AbortSignal): Promise<VoiceTokenResponse> {
  return apiFetch(`/voice/${encodeURIComponent(channelId)}/token`, {
    method: 'POST',
    schema: VoiceTokenResponse,
    signal,
  });
}
