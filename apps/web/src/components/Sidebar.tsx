import type { BootstrapResponse } from '@hearth/shared';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { NavLink } from 'react-router';
import { bootstrapQuery } from '../api/chat';
import { errorMessage } from '../api/errors';
import { dmName } from '../lib/bootstrapPatch';
import { useIsOnline } from '../stores/presence';
import { useUnreadSummary } from '../stores/reads';
import { AvatarWithPresence } from './Avatar';

function linkClass(isActive: boolean, unread: boolean): string {
  const tone = unread ? 'font-semibold text-text' : isActive ? 'font-medium text-text' : 'text-muted';
  return `flex items-center gap-1.5 rounded-md px-2 py-1 text-sm transition hover:bg-white/5 hover:text-text ${
    isActive ? 'bg-white/10' : ''
  } ${tone}`;
}

/**
 * A sidebar `channel-link` (text channel or DM) with `data-unread` (bold when unread) and a
 * `mention-badge` holding the mention count when there is one (docs/plans/phase-4.md, "Web UI
 * contract"). DM links also carry the other user's `data-online` and a status dot. The name (channel
 * name or the DM user's display name) is the child `channel-link-name`.
 */
function ChannelLink({
  channelId,
  dmUserId,
  dmAvatarUrl = null,
  icon,
  label,
}: {
  channelId: string;
  /** For a DM: the other member, whose avatar and presence the link shows. */
  dmUserId?: string;
  dmAvatarUrl?: string | null;
  icon?: ReactNode;
  label: string;
}) {
  const { unread, mentionCount } = useUnreadSummary(channelId);
  const online = useIsOnline(dmUserId);
  const isDm = dmUserId !== undefined;
  return (
    <NavLink
      data-testid="channel-link"
      data-unread={unread ? 'true' : 'false'}
      data-online={isDm ? (online ? 'true' : 'false') : undefined}
      to={`/channels/${channelId}`}
      className={({ isActive }) => linkClass(isActive, unread)}
    >
      {isDm ? (
        <AvatarWithPresence
          userId={dmUserId}
          name={label}
          avatarUrl={dmAvatarUrl}
          size="xs"
          online={online}
        />
      ) : (
        icon
      )}
      <span data-testid="channel-link-name" className="min-w-0 flex-1 truncate">
        {label}
      </span>
      {mentionCount > 0 && (
        <span
          data-testid="mention-badge"
          title={mentionCount === 1 ? '1 mention' : `${mentionCount} mentions`}
          className="shrink-0 rounded-full bg-danger px-1.5 text-[11px] leading-4 font-bold text-white"
        >
          {mentionCount}
        </span>
      )}
    </NavLink>
  );
}

function HashIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className="size-3.5 shrink-0 opacity-70" fill="none">
      <path d="M6 2 4.5 14M11.5 2 10 14M2.5 5.5h11.5M2 10.5h11.5" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

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

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-1">
      <h2 id={id} className="px-2 text-xs font-semibold tracking-wide text-muted">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="px-2 text-xs text-muted/70">{children}</p>;
}

function SidebarLists({ boot }: { boot: BootstrapResponse }) {
  const text = boot.channels.filter((c) => c.type === 'text');
  const voice = boot.channels.filter((c) => c.type === 'voice');
  const dms = boot.dms
    .map((dm) => ({
      dm,
      name: dmName(boot, dm),
      avatarUrl: boot.users.find((u) => u.id === dm.otherUserId)?.avatarUrl ?? null,
    }))
    .toSorted((a, b) => a.name.localeCompare(b.name));

  return (
    <>
      <Section id="sidebar-text" title="Text channels">
        {text.length === 0 ? (
          <Empty>No text channels yet.</Empty>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {text.map((channel) => (
              <li key={channel.id}>
                <ChannelLink channelId={channel.id} icon={<HashIcon />} label={channel.name} />
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section id="sidebar-voice" title="Voice channels">
        {voice.length === 0 ? (
          <Empty>No voice channels yet.</Empty>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {voice.map((channel) => (
              <li key={channel.id}>
                <span
                  data-testid="voice-channel"
                  aria-disabled="true"
                  title="Voice arrives soon"
                  className="flex cursor-not-allowed items-center gap-1.5 truncate rounded-md px-2 py-1 text-sm text-muted/70"
                >
                  <SpeakerIcon />
                  <span className="truncate">{channel.name}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section id="sidebar-dms" title="Direct messages">
        {dms.length === 0 ? (
          <Empty>No conversations yet.</Empty>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {dms.map(({ dm, name, avatarUrl }) => (
              <li key={dm.id}>
                <ChannelLink
                  channelId={dm.id}
                  dmUserId={dm.otherUserId}
                  dmAvatarUrl={avatarUrl}
                  label={name}
                />
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}

/** Left column: text channels, voice channels (not joinable until Phase 6) and DMs. */
export function Sidebar() {
  const boot = useQuery(bootstrapQuery);
  return (
    <nav
      aria-label="Channels"
      className="flex w-60 shrink-0 flex-col gap-5 overflow-y-auto border-r border-white/5 bg-surface px-2 py-4"
    >
      {boot.data ? (
        <SidebarLists boot={boot.data} />
      ) : boot.isError ? (
        <p className="px-2 text-sm text-danger">{errorMessage(boot.error)}</p>
      ) : (
        <p className="px-2 text-sm text-muted">Loading channels…</p>
      )}
    </nav>
  );
}
