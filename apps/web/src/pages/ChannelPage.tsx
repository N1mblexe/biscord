import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { useNavigate, useParams } from 'react-router';
import { meQuery } from '../api/auth';
import { bootstrapQuery } from '../api/chat';
import { Composer } from '../components/chat/Composer';
import { MessageList } from '../components/chat/MessageList';
import { TypingIndicator } from '../components/chat/TypingIndicator';
import { useAttachmentUploads } from '../components/chat/useAttachmentUploads';
import { PageAlert } from '../components/forms';
import { MembersPanel } from '../components/MembersPanel';
import { usePageAlert } from '../components/usePageAlert';
import { channelViewState } from '../lib/bootstrapPatch';
import { useMessageStore } from '../stores/messages';
import { NOTICES, useNoticeStore } from '../stores/notice';

/** `/channels/:channelId` — a text channel or a DM. Access is checked by the route loader. */
export function ChannelPage() {
  const { channelId = '' } = useParams();
  // Keyed: switching channels starts with a fresh draft, alert and scroll state.
  return <ChannelView key={channelId} channelId={channelId} />;
}

function ChannelView({ channelId }: { channelId: string }) {
  const { data: boot } = useQuery(bootstrapQuery);
  const { data: me } = useQuery(meQuery);
  const { message: alert, setAlert, dismiss: dismissAlert } = usePageAlert();

  const uploads = useAttachmentUploads(setAlert);
  const drop = useFileDrop(uploads.addFiles);

  const navigate = useNavigate();
  const users = boot?.users;
  const usersById = useMemo(() => new Map((users ?? []).map((u) => [u.id, u])), [users]);
  const view = channelViewState(boot, channelId);
  const gone = view.status === 'gone';
  // Gone from bootstrap: deleted live (the `channel:deleted` handler is navigating too) or while we
  // were offline (only the refetch on reconnect tells us). Either way it is a deletion.
  useEffect(() => {
    if (!gone) return;
    useNoticeStore.getState().setNotice(NOTICES.channelDeleted);
    useMessageStore.getState().forgetChannel(channelId);
    void navigate('/', { replace: true });
  }, [gone, channelId, navigate]);

  if (view.status !== 'ready' || !boot || !me) return null;
  const { resolved } = view;

  const isDm = resolved.kind === 'dm';
  const title = isDm ? (resolved.otherUser?.displayName ?? 'Unknown user') : `#${resolved.channel.name}`;
  const placeholder = isDm
    ? `Message ${resolved.otherUser?.displayName ?? ''}`.trim()
    : `Message #${resolved.channel.name}`;
  const disabledReason =
    isDm && (resolved.otherUser?.deactivated ?? true)
      ? "This user's account is deactivated; you can't reply."
      : null;

  const canPost = disabledReason === null;

  return (
    <div className="flex min-h-0 flex-1">
      <section
        aria-labelledby="channel-title"
        className="relative flex min-w-0 flex-1 flex-col"
        {...(canPost ? drop.handlers : {})}
      >
        {canPost && drop.active && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-2 z-10 flex items-center justify-center rounded-xl border-2 border-dashed border-accent bg-bg/80 text-sm font-semibold text-accent"
          >
            Drop files to attach
          </div>
        )}
        <header className="flex h-12 shrink-0 items-center border-b border-white/5 px-4">
          <h1 id="channel-title" data-testid="channel-title" className="truncate text-base font-semibold">
            {title}
          </h1>
        </header>
        {alert && (
          <div className="px-4 pt-3">
            <PageAlert message={alert} onDismiss={dismissAlert} />
          </div>
        )}
        <MessageList
          channelId={channelId}
          boot={boot}
          me={me}
          isDm={isDm}
          canReact={canPost}
          onError={setAlert}
        />
        <TypingIndicator channelId={channelId} meId={me.id} usersById={usersById} />
        <Composer
          channelId={channelId}
          authorId={me.id}
          placeholder={placeholder}
          disabledReason={disabledReason}
          uploads={uploads}
          onError={setAlert}
        />
      </section>
      <MembersPanel onError={setAlert} />
    </div>
  );
}

function hasFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer.types).includes('Files');
}

/**
 * Drag-and-drop of files onto the channel view: `active` while files are dragged over it (nested
 * enter/leave events are counted), `onFiles` with what was dropped. Other drags (text, links) are
 * left alone.
 */
function useFileDrop(onFiles: (files: File[]) => void) {
  const [active, setActive] = useState(false);
  const depth = useRef(0);

  const handlers = {
    onDragEnter: (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth.current += 1;
      setActive(true);
    },
    onDragOver: (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    },
    onDragLeave: (event: DragEvent) => {
      if (!hasFiles(event)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setActive(false);
    },
    onDrop: (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth.current = 0;
      setActive(false);
      onFiles(Array.from(event.dataTransfer.files));
    },
  };
  return { active, handlers };
}
