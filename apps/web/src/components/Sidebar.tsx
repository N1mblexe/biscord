import type { BootstrapResponse } from '@hearth/shared';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { NavLink } from 'react-router';
import { bootstrapQuery } from '../api/chat';
import { errorMessage } from '../api/errors';
import { dmName } from '../lib/bootstrapPatch';

const linkClass = ({ isActive }: { isActive: boolean }) =>
  `flex items-center gap-1.5 truncate rounded-md px-2 py-1 text-sm transition hover:bg-white/5 hover:text-text ${
    isActive ? 'bg-white/10 font-medium text-text' : 'text-muted'
  }`;

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
    .map((dm) => ({ dm, name: dmName(boot, dm) }))
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
                <NavLink data-testid="channel-link" to={`/channels/${channel.id}`} className={linkClass}>
                  <HashIcon />
                  <span className="truncate">{channel.name}</span>
                </NavLink>
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
            {dms.map(({ dm, name }) => (
              <li key={dm.id}>
                <NavLink data-testid="channel-link" to={`/channels/${dm.id}`} className={linkClass}>
                  <span className="truncate">{name}</span>
                </NavLink>
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
