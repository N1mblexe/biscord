import { LIMITS, type Invite } from '@hearth/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SubmitEvent } from 'react';
import { createInvite, invitesQuery, revokeInvite } from '../api/admin';
import { errorMessage, fieldErrors } from '../api/errors';
import { FormAlert, FormSuccess, formString, PageAlert, TextField } from '../components/forms';
import { card, dangerButton, primaryButton } from '../components/styles';
import { usePageAlert } from '../components/usePageAlert';

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function inviteLink(code: string): string {
  return `${window.location.origin}/register?invite=${encodeURIComponent(code)}`;
}

export function AdminInvitesPage() {
  const queryClient = useQueryClient();
  const invites = useQuery(invitesQuery);

  const createMutation = useMutation({
    mutationFn: createInvite,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: invitesQuery.queryKey }),
  });
  const revokeMutation = useMutation({
    mutationFn: revokeInvite,
    onSettled: () => queryClient.invalidateQueries({ queryKey: invitesQuery.queryKey }),
  });

  const onSubmit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    revokeMutation.reset();
    createMutation.mutate({
      maxUses: Number(formString(data, 'maxUses')),
      expiresInHours: Number(formString(data, 'expiresInHours')),
    });
  };

  const onRevoke = (invite: Invite) => {
    createMutation.reset();
    revokeMutation.mutate(invite.id);
  };

  // One alert for the page: the most relevant failed action.
  const failed = createMutation.isError
    ? createMutation.error
    : revokeMutation.isError
      ? revokeMutation.error
      : null;
  const errors = fieldErrors(createMutation.error);
  const created = createMutation.data;
  // The page's single alert slot, shared with the app-wide camera and screen share errors.
  const slot = usePageAlert(failed ? errorMessage(failed) : null);

  return (
    <div className="flex flex-col gap-6">
      {slot.shared && <PageAlert message={slot.message} onDismiss={slot.dismiss} />}
      <section className={card} aria-labelledby="invites-create-heading">
        <h1 id="invites-create-heading" className="text-2xl font-semibold tracking-tight">
          Invites
        </h1>
        <form className="mt-4 flex flex-col gap-4" onSubmit={onSubmit} noValidate>
          <div className="grid max-w-md grid-cols-1 gap-4 sm:grid-cols-2">
            <TextField
              id="invite-max-uses"
              name="maxUses"
              label="Max uses"
              type="number"
              inputMode="numeric"
              min={1}
              max={LIMITS.inviteMaxUses}
              defaultValue={1}
              errors={errors}
            />
            <TextField
              id="invite-expires"
              name="expiresInHours"
              label="Expires in (hours)"
              type="number"
              inputMode="numeric"
              min={1}
              max={LIMITS.inviteMaxExpiresHours}
              defaultValue={LIMITS.inviteDefaultExpiresHours}
              errors={errors}
            />
          </div>
          <FormAlert message={slot.shared ? null : slot.message} />
          {created && (
            <FormSuccess>
              Invite created. Share this link:{' '}
              <span data-testid="new-invite-link" className="font-mono break-all select-all">
                {inviteLink(created.code)}
              </span>
            </FormSuccess>
          )}
          <div>
            <button type="submit" className={primaryButton} disabled={createMutation.isPending}>
              Create invite
            </button>
          </div>
        </form>
      </section>

      <section className={card} aria-labelledby="invites-list-heading">
        <h2 id="invites-list-heading" className="text-lg font-semibold">
          All invites
        </h2>
        {invites.isPending ? (
          <p className="mt-4 text-sm text-muted">Loading invites…</p>
        ) : invites.isError ? (
          <p className="mt-4 text-sm text-danger">{errorMessage(invites.error)}</p>
        ) : invites.data.length === 0 ? (
          <p className="mt-4 text-sm text-muted">No invites yet.</p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs tracking-wide text-muted uppercase">
                <tr>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Code
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Uses
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Expires
                  </th>
                  <th scope="col" className="py-2 font-medium">
                    Status
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {invites.data.map((invite) => (
                  <InviteRow
                    key={invite.id}
                    invite={invite}
                    asOf={invites.dataUpdatedAt}
                    revoking={revokeMutation.isPending && revokeMutation.variables === invite.id}
                    onRevoke={onRevoke}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

interface InviteRowProps {
  invite: Invite;
  /** When the list was fetched; "expired" is judged against it (keeps render pure). */
  asOf: number;
  revoking: boolean;
  onRevoke: (invite: Invite) => void;
}

function InviteRow({ invite, asOf, revoking, onRevoke }: InviteRowProps) {
  const expired = Date.parse(invite.expiresAt) <= asOf;
  const usedUp = invite.uses >= invite.maxUses;
  return (
    <tr data-testid="invite-row">
      <td className="py-2 pr-4">
        <span data-testid="invite-code" className="font-mono">
          {invite.code}
        </span>
      </td>
      <td className="py-2 pr-4 tabular-nums">
        {invite.uses} / {invite.maxUses}
      </td>
      <td className="py-2 pr-4">
        <time dateTime={invite.expiresAt}>{formatDate(invite.expiresAt)}</time>
        {expired && <span className="ml-2 text-xs text-muted">(expired)</span>}
      </td>
      <td className="py-2">
        {invite.revokedAt ? (
          <span className="text-xs font-medium text-muted">revoked</span>
        ) : (
          <div className="flex items-center gap-3">
            {usedUp && <span className="text-xs text-muted">used</span>}
            <button
              type="button"
              className={dangerButton}
              disabled={revoking}
              onClick={() => {
                onRevoke(invite);
              }}
            >
              Revoke
            </button>
          </div>
        )}
      </td>
    </tr>
  );
}
