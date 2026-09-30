import type { BootstrapResponse } from '@hearth/shared';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { NavLink } from 'react-router';
import { meQuery } from '../api/auth';
import { bootstrapQuery } from '../api/chat';
import { errorMessage } from '../api/errors';
import { displayUser } from '../lib/bootstrapPatch';
import { useDrawerStore } from '../stores/drawers';
import { useIsOnline } from '../stores/presence';
import { useUnreadSummary } from '../stores/reads';
import { AvatarWithPresence } from './Avatar';
import { CloseIcon, drawerClasses, drawerIconButton, useDrawerPanel } from './Drawer';
import { VoiceChannelItem } from './VoiceChannels';
import { VoicePanel } from './VoicePanel';

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
  dmDeleted = false,
  icon,
  label,
}: {
  channelId: string;
  /** For a DM: the other member, whose avatar and presence the link shows. */
  dmUserId?: string;
  dmAvatarUrl?: string | null;
  /** For a DM: the other member is deactivated ("Deleted user", neutral avatar). */
  dmDeleted?: boolean;
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
          deleted={dmDeleted}
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
    .map((dm) => ({ dm, ...displayUser(boot.users.find((u) => u.id === dm.otherUserId)) }))
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
              <VoiceChannelItem
                key={channel.id}
                channel={channel}
                users={boot.users}
                meId={boot.me.id}
                isAdmin={boot.me.role === 'admin'}
              />
            ))}
          </ul>
        )}
      </Section>
      <Section id="sidebar-dms" title="Direct messages">
        {dms.length === 0 ? (
          <Empty>No conversations yet.</Empty>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {dms.map(({ dm, name, avatarUrl, deleted }) => (
              <li key={dm.id}>
                <ChannelLink
                  channelId={dm.id}
                  dmUserId={dm.otherUserId}
                  dmAvatarUrl={avatarUrl}
                  dmDeleted={deleted}
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

const mainLinkClass = ({ isActive }: { isActive: boolean }) =>
  `rounded-md px-2.5 py-1.5 text-sm font-medium transition hover:bg-white/5 ${
    isActive ? 'bg-white/5 text-text' : 'text-muted'
  }`;

/**
 * The drawer's own header on phones: its close button and the **Main** links (Settings, Admin) that
 * the app header shows from `md` up. Hidden from `md` up, so each link exists once per layout.
 */
function DrawerHeader() {
  const { data: me } = useQuery(meQuery);
  const close = useDrawerStore((s) => s.close);
  return (
    <div className="flex shrink-0 flex-col gap-2 border-b border-white/5 px-2 py-2 md:hidden">
      <div className="flex items-center justify-between pl-2">
        <span className="text-base font-semibold tracking-tight">Hearth</span>
        <button type="button" aria-label="Close navigation" className={drawerIconButton} onClick={close}>
          <CloseIcon />
        </button>
      </div>
      <nav aria-label="Main" className="flex items-center gap-1">
        <NavLink to="/settings" className={mainLinkClass}>
          Settings
        </NavLink>
        {me?.role === 'admin' && (
          <NavLink to="/admin/invites" className={mainLinkClass}>
            Admin
          </NavLink>
        )}
      </nav>
    </div>
  );
}

/**
 * Left column: text channels, voice channels (click to join) and DMs, with the voice panel below.
 * Below `md` it is an off-canvas drawer (`#app-sidebar`), opened by the header's **Open navigation**.
 */
export function Sidebar() {
  const boot = useQuery(bootstrapQuery);
  const { ref, open, dialogProps } = useDrawerPanel<HTMLDivElement>('nav', 'Navigation');
  return (
    <div
      ref={ref}
      id="app-sidebar"
      {...dialogProps}
      className={`flex w-60 shrink-0 flex-col border-r border-white/5 bg-surface outline-none ${drawerClasses('left', open)}`}
    >
      <DrawerHeader />
      <nav aria-label="Channels" className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-2 py-4">
        {boot.data ? (
          <SidebarLists boot={boot.data} />
        ) : boot.isError ? (
          <p className="px-2 text-sm text-danger">{errorMessage(boot.error)}</p>
        ) : (
          <p className="px-2 text-sm text-muted">Loading channels…</p>
        )}
      </nav>
      <VoicePanel />
    </div>
  );
}
