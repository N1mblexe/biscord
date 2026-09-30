import type { BootstrapResponse, PublicUser, ResetCodeResponse } from '@hearth/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import {
  deactivateUser,
  generateResetCode,
  reactivateUser,
  setUserRole,
  usersQuery,
  usersQueryKey,
} from '../api/admin';
import { meQuery } from '../api/auth';
import { bootstrapQueryKey } from '../api/chat';
import { errorMessage } from '../api/errors';
import { Avatar } from '../components/Avatar';
import { FormAlert, FormSuccess, PageAlert } from '../components/forms';
import { PresenceDot } from '../components/PresenceDot';
import { card, dangerButton, secondaryButton } from '../components/styles';
import { usePageAlert } from '../components/usePageAlert';
import {
  ADMIN_USER_ACTION_LABELS,
  adminUserError,
  reduceUsers,
  sortUsers,
  userActions,
  userStatus,
  type AdminUserAction,
  type UsersChange,
} from '../lib/adminUsers';
import { upsertUser } from '../lib/bootstrapPatch';
import { useIsOnline } from '../stores/presence';

const smallButton = `${secondaryButton} px-2 py-1 text-xs`;

const dangerSolidButton =
  'inline-flex items-center justify-center rounded-lg bg-danger px-4 py-2 text-sm font-semibold text-white ' +
  'transition hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 ' +
  'focus-visible:outline-danger disabled:cursor-not-allowed disabled:opacity-50';

interface IssuedCode extends ResetCodeResponse {
  username: string;
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * `/admin/users` (docs/plans/phase-8.md, "Web UI contract"): every user with role, status and
 * presence, and the admin actions of rows 35–38. **Deactivate** asks first (**Deactivate user**
 * dialog); the others act directly. One alert for the page (usePageAlert), shown in the dialog
 * while it is open.
 */
export function AdminUsersPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const users = useQuery(usersQuery);
  const meId = useQuery(meQuery).data?.id;
  const { message: alert, setAlert, dismiss } = usePageAlert();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [deactivating, setDeactivating] = useState<PublicUser | null>(null);
  const [issued, setIssued] = useState<IssuedCode | null>(null);

  const applyChange = (change: UsersChange) => {
    queryClient.setQueryData<PublicUser[]>(usersQueryKey, (old) => reduceUsers(old, change));
  };

  /** Runs one row's request: the alert is cleared first and set on failure; true on success. */
  const run = async (user: PublicUser, request: () => Promise<void>): Promise<boolean> => {
    setAlert(null);
    setIssued(null);
    setBusyId(user.id);
    try {
      await request();
      return true;
    } catch (err) {
      setAlert(adminUserError(err));
      return false;
    } finally {
      setBusyId(null);
    }
  };

  const onAction = (user: PublicUser, action: AdminUserAction) => {
    switch (action) {
      case 'makeAdmin':
      case 'removeAdmin':
        void run(user, async () => {
          const updated = await setUserRole(user.id, action === 'makeAdmin' ? 'admin' : 'member');
          applyChange({ type: 'user', user: updated });
          queryClient.setQueryData<BootstrapResponse>(bootstrapQueryKey, (boot) =>
            boot ? upsertUser(boot, updated) : boot,
          );
          if (updated.id === meId) {
            queryClient.setQueryData(meQuery.queryKey, (me) => (me ? { ...me, ...updated } : me));
            // We just gave up our own admin role: this page is no longer ours.
            if (updated.role !== 'admin') void navigate('/', { replace: true });
          }
        });
        return;
      case 'resetCode':
        void run(user, async () => {
          const code = await generateResetCode(user.id);
          setIssued({ ...code, username: user.username });
        });
        return;
      case 'deactivate':
        setAlert(null);
        setDeactivating(user);
        return;
      case 'reactivate':
        void run(user, async () => {
          await reactivateUser(user.id);
          applyChange({ type: 'deactivated', userId: user.id, deactivated: false });
        });
        return;
    }
  };

  const onConfirmDeactivate = async (user: PublicUser) => {
    const ok = await run(user, async () => {
      await deactivateUser(user.id);
      applyChange({ type: 'deactivated', userId: user.id, deactivated: true });
    });
    if (ok) setDeactivating(null);
  };

  const list = users.data ? sortUsers(users.data) : [];

  return (
    <section className={`${card} max-md:p-4`} aria-labelledby="users-heading">
      <h1 id="users-heading" className="text-2xl font-semibold tracking-tight">
        Users
      </h1>
      <p className="mt-1 text-sm text-muted">
        Deactivating signs a user out everywhere and removes them from voice; their messages stay, shown as
        “Deleted user”. A reset code lets a user set a new password on the reset password page: it is shown
        once, expires after 24 hours, and replaces any older code.
      </p>
      {deactivating === null && alert !== null && (
        <div className="mt-4">
          <PageAlert message={alert} onDismiss={dismiss} />
        </div>
      )}
      {issued && (
        <div className="mt-4">
          <FormSuccess>
            Reset code for <span className="font-semibold">{issued.username}</span>:{' '}
            <code data-testid="reset-code" className="font-mono text-base text-text select-all">
              {issued.code}
            </code>
            <span className="mt-1 block text-xs text-muted">Expires {formatDateTime(issued.expiresAt)}</span>
          </FormSuccess>
        </div>
      )}
      {users.isPending ? (
        <p className="mt-6 text-sm text-muted">Loading users…</p>
      ) : users.isError ? (
        <p className="mt-6 text-sm text-danger">{errorMessage(users.error)}</p>
      ) : (
        // Below `md` each row is a card (user; role, status, presence; actions), with no header row.
        <div className="mt-6 md:overflow-x-auto">
          <table className="w-full text-left text-sm max-md:block md:min-w-[40rem]">
            <thead className="text-xs text-muted max-md:hidden">
              <tr className="border-b border-white/5">
                <th scope="col" className="py-2 pr-3 font-semibold">
                  User
                </th>
                <th scope="col" className="py-2 pr-3 font-semibold">
                  Role
                </th>
                <th scope="col" className="py-2 pr-3 font-semibold">
                  Status
                </th>
                <th scope="col" className="py-2 pr-3 font-semibold">
                  Presence
                </th>
                <th scope="col" className="py-2 font-semibold">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5 max-md:block">
              {list.map((user) => (
                <UserRow
                  key={user.id}
                  user={user}
                  isMe={user.id === meId}
                  busy={busyId === user.id}
                  onAction={(action) => {
                    onAction(user, action);
                  }}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {deactivating && (
        <DeactivateDialog
          user={deactivating}
          busy={busyId === deactivating.id}
          alert={alert}
          onConfirm={() => {
            void onConfirmDeactivate(deactivating);
          }}
          onClose={() => {
            setAlert(null);
            setDeactivating(null);
          }}
        />
      )}
    </section>
  );
}

/** One `user-row` (`data-username`) with `user-role`, `user-status`, presence and its actions. */
function UserRow({
  user,
  isMe,
  busy,
  onAction,
}: {
  user: PublicUser;
  isMe: boolean;
  busy: boolean;
  onAction: (action: AdminUserAction) => void;
}) {
  const online = useIsOnline(user.id);
  const status = userStatus(user);
  return (
    <tr
      data-testid="user-row"
      data-username={user.username}
      className="align-middle max-md:flex max-md:flex-wrap max-md:items-center max-md:gap-x-4 max-md:gap-y-2 max-md:py-3"
    >
      <td className="py-2 pr-3 max-md:w-full max-md:p-0">
        <span className="flex min-w-0 items-center gap-2">
          <Avatar
            userId={user.id}
            name={user.displayName}
            avatarUrl={user.avatarUrl}
            deleted={user.deactivated}
            size="sm"
          />
          <span className="min-w-0">
            <span className="block truncate font-medium">
              {user.displayName}
              {isMe && <span className="ml-1 text-xs font-normal text-muted">(you)</span>}
            </span>
            <span className="block truncate text-xs text-muted">@{user.username}</span>
          </span>
        </span>
      </td>
      <td className="py-2 pr-3 max-md:p-0 max-md:text-xs">
        <span
          data-testid="user-role"
          className={user.role === 'admin' ? 'font-medium text-accent' : 'text-muted'}
        >
          {user.role}
        </span>
      </td>
      <td className="py-2 pr-3 max-md:p-0 max-md:text-xs">
        <span data-testid="user-status" className={status === 'active' ? 'text-success' : 'text-danger'}>
          {status}
        </span>
      </td>
      <td className="py-2 pr-3 max-md:p-0">
        <span className="flex items-center gap-1.5 text-xs text-muted">
          <PresenceDot online={online && !user.deactivated} />
          {online && !user.deactivated ? 'Online' : 'Offline'}
        </span>
      </td>
      <td className="py-2 max-md:w-full max-md:p-0">
        <span className="flex flex-wrap justify-end gap-1.5 max-md:justify-start">
          {userActions(user).map((action) => (
            <button
              key={action}
              type="button"
              className={action === 'deactivate' ? dangerButton : smallButton}
              disabled={busy}
              onClick={() => {
                onAction(action);
              }}
            >
              {ADMIN_USER_ACTION_LABELS[action]}
            </button>
          ))}
        </span>
      </td>
    </tr>
  );
}

interface DeactivateDialogProps {
  user: PublicUser;
  busy: boolean;
  alert: string | null;
  onConfirm: () => void;
  onClose: () => void;
}

/** The **Deactivate user** confirm dialog (modal; the page's alert shows inside it while open). */
function DeactivateDialog({ user, busy, alert, onConfirm, onClose }: DeactivateDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    // Guarded for StrictMode's double effect run. Unmounting removes the dialog, which closes it; an
    // explicit close() here would queue a `close` event and dismiss the remounted dialog.
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  return (
    <dialog
      ref={ref}
      aria-labelledby="deactivate-user-heading"
      className="m-auto w-full max-w-md rounded-2xl bg-surface p-6 text-text shadow-xl ring-1 ring-white/10 backdrop:bg-black/60"
      onClose={onClose}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy) onConfirm();
        }}
      >
        <h2 id="deactivate-user-heading" className="text-lg font-semibold">
          Deactivate user
        </h2>
        <p className="text-sm text-muted">
          Deactivate <span className="font-medium text-text">{user.displayName}</span> (@{user.username})?
          They are signed out everywhere and removed from voice. Their messages stay, shown as “Deleted user”,
          and DMs with them become read-only. You can reactivate the account later.
        </p>
        <FormAlert message={alert} />
        <div className="flex justify-end gap-2">
          <button
            type="button"
            className={secondaryButton}
            onClick={() => {
              ref.current?.close();
            }}
          >
            Cancel
          </button>
          <button type="submit" className={dangerSolidButton} disabled={busy}>
            Deactivate
          </button>
        </div>
      </form>
    </dialog>
  );
}
