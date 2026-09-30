import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BootstrapResponse } from '@hearth/shared';
import { useEffect, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { bootstrapQuery, bootstrapQueryKey, openDm } from '../api/chat';
import { errorMessage } from '../api/errors';
import { upsertDm } from '../lib/bootstrapPatch';
import { useDrawerStore } from '../stores/drawers';
import { useIsOnline } from '../stores/presence';
import { AvatarWithPresence } from './Avatar';
import { CloseIcon, drawerClasses, drawerIconButton, useDrawerPanel } from './Drawer';
import { secondaryButton } from './styles';

/**
 * **Message**: compact on desktop so names have room, a comfortable tap target in the phone drawer.
 * (Swapped rather than appended: two padding utilities on one element don't reliably override.)
 */
const messageButton = secondaryButton.replace(
  'px-3 py-1.5 text-sm',
  'px-2.5 py-1 text-xs max-md:px-3 max-md:py-1.5 max-md:text-sm',
);

/**
 * Right column: every active user; **Message** opens (or creates) the DM and navigates to it. Below
 * `md` it is an off-canvas drawer (`#members-panel`), opened by the header's **Members** button; it
 * closes once the DM opens (or fails, so the page's alert is visible).
 */
export function MembersPanel({ onError }: { onError: (message: string | null) => void }) {
  const { data: boot } = useQuery(bootstrapQuery);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { ref, open, dialogProps } = useDrawerPanel<HTMLElement>('members');
  const closeDrawer = useDrawerStore((s) => s.close);

  // The header shows its **Members** button only while a page has this panel.
  useEffect(() => useDrawerStore.getState().hostMembers(), []);

  const dmMutation = useMutation({
    mutationFn: openDm,
    onMutate: () => {
      onError(null);
    },
    onSuccess: (dm) => {
      queryClient.setQueryData<BootstrapResponse>(bootstrapQueryKey, (old) =>
        old ? upsertDm(old, dm) : old,
      );
      closeDrawer();
      void navigate(`/channels/${dm.id}`);
    },
    onError: (err) => {
      closeDrawer();
      onError(errorMessage(err));
    },
  });

  if (!boot) return null;
  const members = boot.users
    .filter((u) => !u.deactivated)
    .toSorted((a, b) => a.displayName.localeCompare(b.displayName));

  return (
    <aside
      ref={ref}
      id="members-panel"
      aria-labelledby="members-heading"
      {...dialogProps}
      className={`flex w-60 shrink-0 flex-col gap-2 overflow-y-auto border-l border-white/5 bg-surface px-3 py-4 outline-none max-md:pt-2 ${drawerClasses('right', open)}`}
    >
      <div className="flex items-center justify-between">
        <h2 id="members-heading" className="px-1 text-xs font-semibold tracking-wide text-muted">
          Members
        </h2>
        <button
          type="button"
          aria-label="Close members"
          className={`${drawerIconButton} md:hidden`}
          onClick={closeDrawer}
        >
          <CloseIcon />
        </button>
      </div>
      <ul className="flex flex-col gap-0.5">
        {members.map((user) => (
          <MemberItem
            key={user.id}
            userId={user.id}
            displayName={user.displayName}
            avatarUrl={user.avatarUrl}
          >
            {user.id !== boot.me.id && (
              <button
                type="button"
                className={messageButton}
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

/** One `member-item`, with `data-online`, the avatar and a status dot. */
function MemberItem({
  userId,
  displayName,
  avatarUrl,
  children,
}: {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
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
        <AvatarWithPresence
          userId={userId}
          name={displayName}
          avatarUrl={avatarUrl}
          size="sm"
          online={online}
        />
        <span className={`truncate text-sm ${online ? '' : 'text-muted'}`}>{displayName}</span>
      </span>
      {children}
    </li>
  );
}
