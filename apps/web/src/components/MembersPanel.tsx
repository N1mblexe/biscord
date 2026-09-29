import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BootstrapResponse } from '@hearth/shared';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { bootstrapQuery, bootstrapQueryKey, openDm } from '../api/chat';
import { errorMessage } from '../api/errors';
import { upsertDm } from '../lib/bootstrapPatch';
import { useIsOnline } from '../stores/presence';
import { PresenceDot } from './PresenceDot';
import { secondaryButton } from './styles';

/** Right column: every active user; **Message** opens (or creates) the DM and navigates to it. */
export function MembersPanel({ onError }: { onError: (message: string | null) => void }) {
  const { data: boot } = useQuery(bootstrapQuery);
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const dmMutation = useMutation({
    mutationFn: openDm,
    onMutate: () => {
      onError(null);
    },
    onSuccess: (dm) => {
      queryClient.setQueryData<BootstrapResponse>(bootstrapQueryKey, (old) =>
        old ? upsertDm(old, dm) : old,
      );
      void navigate(`/channels/${dm.id}`);
    },
    onError: (err) => {
      onError(errorMessage(err));
    },
  });

  if (!boot) return null;
  const members = boot.users
    .filter((u) => !u.deactivated)
    .toSorted((a, b) => a.displayName.localeCompare(b.displayName));

  return (
    <aside
      aria-labelledby="members-heading"
      className="hidden w-56 shrink-0 flex-col gap-2 overflow-y-auto border-l border-white/5 bg-surface px-3 py-4 md:flex"
    >
      <h2 id="members-heading" className="px-1 text-xs font-semibold tracking-wide text-muted">
        Members
      </h2>
      <ul className="flex flex-col gap-0.5">
        {members.map((user) => (
          <MemberItem key={user.id} userId={user.id} displayName={user.displayName}>
            {user.id !== boot.me.id && (
              <button
                type="button"
                className={`${secondaryButton} px-2 py-0.5 text-xs`}
                disabled={dmMutation.isPending}
                onClick={() => {
                  dmMutation.mutate(user.id);
                }}
              >
                Message
              </button>
            )}
          </MemberItem>
        ))}
      </ul>
    </aside>
  );
}

/** One `member-item`, with `data-online` and a status dot. */
function MemberItem({
  userId,
  displayName,
  children,
}: {
  userId: string;
  displayName: string;
  children: ReactNode;
}) {
  const online = useIsOnline(userId);
  return (
    <li
      data-testid="member-item"
      data-online={online ? 'true' : 'false'}
      className="flex items-center justify-between gap-2 rounded-md px-1 py-1 hover:bg-white/5"
    >
      <span className="flex min-w-0 items-center gap-2">
        <PresenceDot online={online} />
        <span className={`truncate text-sm ${online ? '' : 'text-muted'}`}>{displayName}</span>
      </span>
      {children}
    </li>
  );
}
