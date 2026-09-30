import type { Channel, PublicUser, VoiceParticipant } from '@hearth/shared';
import { useEffect, useId, useRef, useState } from 'react';
import { disconnectVoiceParticipant } from '../api/voice';
import { voiceDisconnectError } from '../lib/adminUsers';
import { displayUser } from '../lib/bootstrapPatch';
import { usePageAlertStore } from '../stores/pageAlert';
import { useVoiceParticipants } from '../stores/voice';
import { useVoice } from '../voice/context';
import { useIsSpeakingInMyRoom, useVoiceSession } from '../voice/session';
import { useVolume } from '../voice/volume';
import { Avatar } from './Avatar';

function SpeakerIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className="size-3.5 shrink-0 opacity-70" fill="none">
      <path
        d="M2.5 6h2.5l3.5-3v10L5 10H2.5z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path d="M11 5.5a3.5 3.5 0 0 1 0 5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function MicOffIcon() {
  return (
    <svg
      role="img"
      aria-label="Muted"
      viewBox="0 0 16 16"
      className="size-3.5 shrink-0 text-danger"
      fill="none"
    >
      <title>Muted</title>
      <path d="M6 3.5a2 2 0 0 1 4 0V8a2 2 0 0 1-4 0z" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M3.5 7.5a4.5 4.5 0 0 0 9 0M8 12v2"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
      <path d="m2.5 2.5 11 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function DeafenedIcon() {
  return (
    <svg
      role="img"
      aria-label="Deafened"
      viewBox="0 0 16 16"
      className="size-3.5 shrink-0 text-danger"
      fill="none"
    >
      <title>Deafened</title>
      <path
        d="M2.5 10V8a5.5 5.5 0 0 1 11 0v2M2.5 10h2v3.5h-2zM11.5 10h2v3.5h-2z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path d="m2.5 2.5 11 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function CameraIcon() {
  return (
    <svg
      role="img"
      aria-label="Camera on"
      viewBox="0 0 16 16"
      className="size-3.5 shrink-0 text-accent"
      fill="none"
    >
      <title>Camera on</title>
      <rect x="1.5" y="4" width="9" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="m10.5 7 4-2.5v7l-4-2.5" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  );
}

/** The screen-share badge (`data-live="screen"` on the row). */
function LiveBadge() {
  return (
    <span
      title="Sharing their screen"
      className="shrink-0 rounded bg-danger-strong px-1 py-px text-[10px] leading-none font-bold tracking-wide text-white"
    >
      LIVE
    </span>
  );
}

function VolumeIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className="size-3.5" fill="none">
      <path d="M3 5v6M8 3v10M13 6v4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/**
 * The **Volume** context button of a participant row and its menu: the slider (**Volume for <name>**,
 * 0–100) and, for admins, **Disconnect** (row 31; docs/plans/phase-8.md "Web UI contract"). A failed
 * disconnect goes to the page's alert.
 */
function VolumeControl({
  userId,
  channelId,
  displayName,
  canDisconnect,
  open,
  onOpenChange,
}: {
  userId: string;
  channelId: string;
  displayName: string;
  /** We are an admin (never offered on our own row, which has no menu). */
  canDisconnect: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const volume = useVolume(userId);
  const { setUserVolume } = useVoice();
  const sliderId = useId();
  const percent = Math.round(volume * 100);
  const [disconnecting, setDisconnecting] = useState(false);

  const onDisconnect = () => {
    setDisconnecting(true);
    disconnectVoiceParticipant(channelId, userId).then(
      () => {
        // They disappear from the list with the server's `voice:left`.
        setDisconnecting(false);
        onOpenChange(false);
      },
      (err: unknown) => {
        setDisconnecting(false);
        usePageAlertStore.getState().show(voiceDisconnectError(err));
      },
    );
  };

  return (
    <>
      <button
        type="button"
        aria-label="Volume"
        title={`Volume for ${displayName}`}
        aria-expanded={open}
        aria-controls={open ? sliderId : undefined}
        className="ml-auto inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted transition hover:bg-white/10 hover:text-text aria-expanded:bg-white/10 aria-expanded:text-text"
        onClick={() => {
          onOpenChange(!open);
        }}
      >
        <VolumeIcon />
      </button>
      {open && (
        <div className="flex w-full basis-full items-center gap-2 py-1 pl-6">
          <input
            id={sliderId}
            type="range"
            min={0}
            max={100}
            step={1}
            value={percent}
            aria-label={`Volume for ${displayName}`}
            aria-valuetext={`${percent}%`}
            className="h-1 min-w-0 flex-1 accent-accent"
            onChange={(e) => {
              setUserVolume(userId, Number(e.currentTarget.value) / 100);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onOpenChange(false);
            }}
          />
          <span className="w-9 shrink-0 text-right text-2xs text-muted tabular-nums">{percent}%</span>
        </div>
      )}
      {open && canDisconnect && (
        <div className="flex w-full basis-full justify-end pb-1 pl-6">
          <button
            type="button"
            className="rounded-md px-2 py-0.5 text-xs font-semibold text-danger ring-1 ring-danger/40 transition hover:bg-danger/10 focus-visible:outline-danger disabled:opacity-60"
            disabled={disconnecting}
            onClick={onDisconnect}
          >
            Disconnect
          </button>
        </div>
      )}
    </>
  );
}

/**
 * One `voice-participant` row: `data-user-id`, `data-muted` / `data-deafened` ("true"/"false", from
 * the server's `voice:state`), and `data-speaking` only for people in our own room (docs/plans/
 * phase-6.md, "Web UI contract"). Phase 7: `data-camera` ("true"/"false") with a camera icon, and
 * `data-live="screen"` with a **LIVE** badge while sharing. Right-click or **Volume** opens the
 * participant's menu: the local volume slider and, for admins, **Disconnect** (phase 8).
 */
function VoiceParticipantRow({
  channelId,
  participant,
  user,
  isMe,
  isAdmin,
  inMyRoom,
}: {
  channelId: string;
  participant: VoiceParticipant;
  user: PublicUser | undefined;
  isMe: boolean;
  isAdmin: boolean;
  inMyRoom: boolean;
}) {
  const speaking = useIsSpeakingInMyRoom(participant.userId) && inMyRoom;
  const [volumeOpen, setVolumeOpen] = useState(false);
  const rowRef = useRef<HTMLLIElement>(null);
  const { name, avatarUrl, deleted } = displayUser(user);

  // Close the slider on a click outside this row. On `click`, not `pointerdown`: the slider sits in
  // the list, so closing it moves the rows below, and the click being made must land first. A drag
  // that starts on the slider and ends outside doesn't count.
  useEffect(() => {
    if (!volumeOpen) return;
    const inside = (target: EventTarget | null) =>
      target instanceof Node && rowRef.current?.contains(target) === true;
    let pressedInside = false;
    const onPointerDown = (e: PointerEvent) => {
      pressedInside = inside(e.target);
    };
    const onClick = (e: MouseEvent) => {
      if (!pressedInside && !inside(e.target)) setVolumeOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('click', onClick);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('click', onClick);
    };
  }, [volumeOpen]);

  return (
    <li
      ref={rowRef}
      data-testid="voice-participant"
      data-user-id={participant.userId}
      data-muted={participant.selfMute ? 'true' : 'false'}
      data-deafened={participant.selfDeaf ? 'true' : 'false'}
      data-camera={participant.camera ? 'true' : 'false'}
      data-live={participant.screen ? 'screen' : undefined}
      data-speaking={inMyRoom ? (speaking ? 'true' : 'false') : undefined}
      className="flex min-h-7 flex-wrap items-center gap-2 rounded-md px-2 py-0.5 text-sm text-muted hover:bg-white/5"
      onContextMenu={
        isMe
          ? undefined
          : (e) => {
              e.preventDefault();
              setVolumeOpen(true);
            }
      }
    >
      <span
        className={`inline-flex shrink-0 rounded-full ring-2 ring-offset-1 ring-offset-surface transition ${speaking ? 'ring-success' : 'ring-transparent'}`}
      >
        <Avatar userId={participant.userId} name={name} avatarUrl={avatarUrl} deleted={deleted} size="xs" />
      </span>
      <span className={`min-w-0 flex-1 truncate ${speaking ? 'text-text' : ''}`}>{name}</span>
      {participant.screen && <LiveBadge />}
      {participant.camera && <CameraIcon />}
      {participant.selfDeaf ? <DeafenedIcon /> : participant.selfMute ? <MicOffIcon /> : null}
      {!isMe && (
        <VolumeControl
          userId={participant.userId}
          channelId={channelId}
          displayName={name}
          canDisconnect={isAdmin}
          open={volumeOpen}
          onOpenChange={setVolumeOpen}
        />
      )}
    </li>
  );
}

/**
 * A voice channel in the sidebar: the `voice-channel` button (click = join; its text is just the
 * channel name) followed by its participants, for everyone, joined or not.
 */
export function VoiceChannelItem({
  channel,
  users,
  meId,
  isAdmin,
}: {
  channel: Channel;
  users: readonly PublicUser[];
  meId: string;
  /** Admins get **Disconnect** in other participants' menus. */
  isAdmin: boolean;
}) {
  const participants = useVoiceParticipants(channel.id);
  const { join } = useVoice();
  const mine = useVoiceSession((s) => s.channelId === channel.id && s.state !== 'disconnected');
  const inMyRoom = useVoiceSession(
    (s) => s.channelId === channel.id && (s.state === 'connected' || s.state === 'reconnecting'),
  );

  return (
    <li>
      <button
        type="button"
        data-testid="voice-channel"
        data-channel-id={channel.id}
        aria-current={mine ? 'true' : undefined}
        title={mine ? undefined : `Join ${channel.name}`}
        className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition hover:bg-white/5 hover:text-text ${
          mine ? 'bg-white/10 font-medium text-text' : 'text-muted'
        }`}
        onClick={() => {
          join(channel.id);
        }}
      >
        <SpeakerIcon />
        <span className="min-w-0 flex-1 truncate">{channel.name}</span>
      </button>
      {participants.length > 0 && (
        <ul
          aria-label={`In ${channel.name}`}
          className="mt-0.5 mb-1 ml-3 flex flex-col gap-0.5 border-l border-line pl-1"
        >
          {participants.map((p) => (
            <VoiceParticipantRow
              key={p.userId}
              channelId={channel.id}
              participant={p}
              user={users.find((u) => u.id === p.userId)}
              isMe={p.userId === meId}
              isAdmin={isAdmin}
              inMyRoom={inMyRoom}
            />
          ))}
        </ul>
      )}
    </li>
  );
}
