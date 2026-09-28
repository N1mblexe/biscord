import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { meQuery } from '../api/auth';
import { bootstrapQuery } from '../api/chat';
import { PageAlert } from '../components/forms';
import { MembersPanel } from '../components/MembersPanel';
import { card, linkClass } from '../components/styles';

/**
 * `/`: the loader redirects to the first text channel. This page shows when there is none, or when
 * the user was just sent here with a notice (e.g. the channel they were viewing was deleted).
 */
export function HomePage() {
  const { data: me } = useQuery(meQuery);
  const { data: boot } = useQuery(bootstrapQuery);
  const [alert, setAlert] = useState<string | null>(null);
  if (!me) return null;

  const hasTextChannel = boot?.channels.some((c) => c.type === 'text') ?? false;

  return (
    <div className="flex min-h-0 flex-1">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-8">
          <PageAlert
            message={alert}
            onDismiss={() => {
              setAlert(null);
            }}
          />
          <section className={card}>
            <h1 data-testid="home-welcome" className="text-2xl font-semibold tracking-tight">
              Welcome, {me.displayName}
            </h1>
            {hasTextChannel ? (
              <p className="mt-2 text-sm text-muted">Pick a channel from the sidebar to start chatting.</p>
            ) : me.role === 'admin' ? (
              <p className="mt-2 text-sm text-muted">
                There are no text channels yet.{' '}
                <Link to="/admin/channels" className={linkClass}>
                  Create the first channel
                </Link>
              </p>
            ) : (
              <p className="mt-2 text-sm text-muted">
                There are no text channels yet. Ask an admin to create one — or message someone directly.
              </p>
            )}
          </section>
        </div>
      </div>
      <MembersPanel onError={setAlert} />
    </div>
  );
}
