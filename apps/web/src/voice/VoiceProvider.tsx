import { VoiceKickedPayload } from '@hearth/shared';
import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useSocket } from '../socket/context';
import { useNoticeStore } from '../stores/notice';
import { VoiceContext, VoiceRoomContext, type VoiceActions } from './context';
import { voiceMessage } from './controller';
import { idleVoiceDebug, installVoiceDebug } from './debugHook';
import type { VoiceEngine } from './engine';
import { planVoiceKick } from './kick';
import { registerVoiceLeave, toggleDeafen, toggleMute, useVoiceSession } from './session';
import { useVolumeStore } from './volume';

type EngineModule = typeof import('./engine');

interface LoadedEngine {
  module: EngineModule;
  engine: VoiceEngine;
}

/** The loaded engine module and instance (null until the first join). */
const LoadedEngineContext = createContext<LoadedEngine | null>(null);

/** Loads the LiveKit chunk (voice/engine.tsx). A separate function so tests can check the split. */
export function loadVoiceEngine(): Promise<EngineModule> {
  return import('./engine');
}

/**
 * Voice for the whole signed-in app (docs/plans/phase-6.md, "Key decisions → Web"). LiveKit itself
 * lives in a lazy chunk (voice/engine.tsx, docs/plans/phase-8.md "Bundle size"): it is loaded on
 * the first **join** and then kept, with one `Room`, until the protected layout unmounts (logout,
 * revoked session), when we leave the room. Until then the actions only touch local state.
 *
 * Also handles `voice:kicked` (CONTRACTS B.7b rule 4): leave cleanly and show why.
 */
export function VoiceProvider({ children }: { children: ReactNode }) {
  const { socket } = useSocket();
  const [loaded, setLoaded] = useState<LoadedEngine | null>(null);
  // Read by the actions (event handlers), so they work right after loading, before a re-render.
  const engineRef = useRef<VoiceEngine | null>(null);
  const loadingRef = useRef(false);
  const pendingJoinRef = useRef<string | null>(null);
  const aliveRef = useRef(false);

  // Leave on logout / revoked session (lib/session.ts) and when the layout unmounts. The engine's
  // own effects only attach listeners, so StrictMode's re-run can't cut a join short.
  useEffect(() => {
    aliveRef.current = true;
    const leave = () => {
      pendingJoinRef.current = null;
      engineRef.current?.actions.leave();
    };
    const unregister = registerVoiceLeave(leave);
    return () => {
      aliveRef.current = false;
      unregister();
      leave();
    };
  }, []);

  // A join made before the engine was loaded runs once its listeners are attached (child effects
  // run before this one).
  useEffect(() => {
    if (loaded === null) return;
    const channelId = pendingJoinRef.current;
    pendingJoinRef.current = null;
    if (channelId !== null) loaded.engine.actions.join(channelId);
  }, [loaded]);

  // `voice:kicked`: remember the last channel we were in, so a kick that arrives after LiveKit
  // already dropped us still explains it.
  useEffect(() => {
    let lastChannelId = useVoiceSession.getState().channelId;
    const unsubscribe = useVoiceSession.subscribe((s) => {
      if (s.channelId !== null) lastChannelId = s.channelId;
    });
    const onKicked = (payload: unknown) => {
      const parsed = VoiceKickedPayload.safeParse(payload);
      if (!parsed.success) return;
      const s = useVoiceSession.getState();
      const plan = planVoiceKick(parsed.data, { channelId: s.channelId, state: s.state, lastChannelId });
      if (plan.leave) {
        pendingJoinRef.current = null;
        engineRef.current?.actions.leave();
      }
      if (plan.notice !== null) useNoticeStore.getState().setNotice(plan.notice);
    };
    socket.on('voice:kicked', onKicked);
    return () => {
      unsubscribe();
      socket.off('voice:kicked', onKicked);
    };
  }, [socket]);

  useEffect(
    () => installVoiceDebug(() => engineRef.current?.debug?.() ?? Promise.resolve(idleVoiceDebug())),
    [],
  );

  const actions = useMemo<VoiceActions>(() => {
    const engine = () => engineRef.current?.actions ?? null;
    const load = () => {
      if (loadingRef.current) return;
      loadingRef.current = true;
      loadVoiceEngine().then(
        (module) => {
          if (!aliveRef.current) {
            loadingRef.current = false;
            return;
          }
          const created = module.createVoiceEngine(socket);
          engineRef.current = created;
          setLoaded({ module, engine: created });
        },
        () => {
          loadingRef.current = false;
          if (pendingJoinRef.current === null) return;
          pendingJoinRef.current = null;
          useNoticeStore.getState().setNotice(voiceMessage('joinFailed'));
        },
      );
    };
    return {
      join: (channelId) => {
        const e = engine();
        if (e) {
          e.join(channelId);
          return;
        }
        pendingJoinRef.current = channelId;
        load();
      },
      leave: () => {
        pendingJoinRef.current = null;
        engine()?.leave();
      },
      // Not in voice yet: mute/deafen are just remembered for the next join.
      toggleMute: () => {
        const e = engine();
        if (e) e.toggleMute();
        else useVoiceSession.getState().set(toggleMute(useVoiceSession.getState()));
      },
      toggleDeafen: () => {
        const e = engine();
        if (e) e.toggleDeafen();
        else useVoiceSession.getState().set(toggleDeafen(useVoiceSession.getState()));
      },
      toggleCamera: () => {
        engine()?.toggleCamera();
      },
      toggleScreen: () => {
        engine()?.toggleScreen();
      },
      setUserVolume: (userId, volume) => {
        const e = engine();
        if (e) e.setUserVolume(userId, volume);
        else useVolumeStore.getState().setVolume(userId, volume);
      },
      startAudio: () => {
        engine()?.startAudio();
      },
    };
  }, [socket]);

  return (
    <VoiceContext value={actions}>
      <VoiceRoomContext value={loaded?.engine.room ?? null}>
        <LoadedEngineContext value={loaded}>
          {children}
          {loaded && createElement(loaded.module.VoiceEngineView, { engine: loaded.engine })}
        </LoadedEngineContext>
      </VoiceRoomContext>
    </VoiceContext>
  );
}

/** Where the video stage goes (AppLayout): nothing until the voice engine is loaded. */
export function VideoStageSlot() {
  const loaded = useContext(LoadedEngineContext);
  return loaded ? createElement(loaded.module.VideoStage) : null;
}
