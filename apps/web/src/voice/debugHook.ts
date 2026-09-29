import { useVoiceSession } from './session';

/**
 * The report while the voice engine (the lazy LiveKit chunk, voice/engine.tsx) isn't loaded yet:
 * never joined in this page, so there is no room.
 */
export function idleVoiceDebug(): HearthVoiceDebug {
  const s = useVoiceSession.getState();
  return {
    state: 'disconnected',
    roomName: null,
    localIdentity: null,
    channelId: s.channelId,
    playbackMuted: false,
    micMuted: s.micMuted,
    deafened: s.deafened,
    canPlaybackAudio: true,
    activeSpeakers: [],
    speaking: [],
    remotes: [],
    local: { camera: false, screen: false },
  };
}

/**
 * E2E builds only (`VITE_E2E=true`): `window.__hearthDebug.voice()` reports the LiveKit room as the
 * voice specs need it (voice/debug.ts), or the idle report before the engine is loaded.
 * In every other build `import.meta.env.VITE_E2E` is replaced statically, so this is dead code.
 */
export function installVoiceDebug(report: () => Promise<HearthVoiceDebug>): () => void {
  if (import.meta.env.VITE_E2E !== 'true') return () => undefined;
  const hook = { voice: report };
  window.__hearthDebug = hook;
  return () => {
    if (window.__hearthDebug === hook) delete window.__hearthDebug;
  };
}
