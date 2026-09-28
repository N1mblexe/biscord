import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { meQuery } from '../api/auth';
import { bootstrapQuery } from '../api/chat';
import { Composer } from '../components/chat/Composer';
import { MessageList } from '../components/chat/MessageList';
import { PageAlert } from '../components/forms';
import { MembersPanel } from '../components/MembersPanel';
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
  const [alert, setAlertState] = useState<string | null>(null);
  const setAlert = useCallback((message: string | null) => {
    setAlertState(message);
  }, []);

  const navigate = useNavigate();
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

  return (
    <div className="flex min-h-0 flex-1">
      <section aria-labelledby="channel-title" className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center border-b border-white/5 px-4">
          <h1 id="channel-title" data-testid="channel-title" className="truncate text-base font-semibold">
            {title}
          </h1>
        </header>
        {alert && (
          <div className="px-4 pt-3">
            <PageAlert
              message={alert}
              onDismiss={() => {
                setAlert(null);
              }}
            />
          </div>
        )}
        <MessageList channelId={channelId} boot={boot} me={me} isDm={isDm} onError={setAlert} />
        <Composer
          channelId={channelId}
          authorId={me.id}
          placeholder={placeholder}
          disabledReason={disabledReason}
          onError={setAlert}
        />
      </section>
      <MembersPanel onError={setAlert} />
    </div>
  );
}
