import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { meQuery } from '../api/auth';
import { bootstrapQuery } from '../api/chat';
import { EmptyState } from '../components/EmptyState';
import { PageAlert } from '../components/forms';
import { MembersPanel } from '../components/MembersPanel';
import { usePageAlert } from '../components/usePageAlert';
import { primaryButton } from '../components/styles';
import { useT } from '../i18n/useT';
import { noChannelsCopy } from '../lib/emptyStates';

/**
 * `/`: the loader redirects to the first text channel. This page shows when there is none, or when
 * the user was just sent here with a notice (e.g. the channel they were viewing was deleted).
 */
export function HomePage() {
  const t = useT();
  const { data: me } = useQuery(meQuery);
  const { data: boot } = useQuery(bootstrapQuery);
  const { message: alert, setAlert, dismiss: dismissAlert } = usePageAlert();
  if (!me) return null;

  const hasTextChannel = boot?.channels.some((c) => c.type === 'text') ?? false;
  const isAdmin = me.role === 'admin';
  const empty = noChannelsCopy(isAdmin);

  return (
    <div className="flex min-h-0 flex-1">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-3 py-6 sm:px-4 sm:py-12">
          <PageAlert message={alert} onDismiss={dismissAlert} />
          <section className="rounded-card bg-surface px-4 pt-6 pb-2 shadow-card ring-1 ring-line sm:px-8 sm:pt-8">
            <h1
              data-testid="home-welcome"
              className="text-center text-2xl font-semibold tracking-tight break-words"
            >
              {t('common.home.welcome', { name: me.displayName })}
            </h1>
            {hasTextChannel ? (
              <EmptyState icon="chat" title={t('common.home.pickChannel')} headingLevel={2}>
                {t('common.home.pickChannelBody')}
              </EmptyState>
            ) : (
              <EmptyState
                icon="channels"
                title={empty.title}
                action={
                  isAdmin ? (
                    <Link to="/admin/channels" className={primaryButton}>
                      {t('common.home.createFirstChannel')}
                    </Link>
                  ) : undefined
                }
              >
                {empty.body}
              </EmptyState>
            )}
          </section>
        </div>
      </div>
      <MembersPanel onError={setAlert} />
    </div>
  );
}
