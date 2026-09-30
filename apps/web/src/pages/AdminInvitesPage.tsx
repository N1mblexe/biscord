import { LIMITS, type Invite } from '@hearth/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SubmitEvent } from 'react';
import { createInvite, invitesQuery, revokeInvite } from '../api/admin';
import { errorMessage, fieldErrors, formAlertMessage } from '../api/errors';
import { FormAlert, FormSuccess, formString, PageAlert, TextField } from '../components/forms';
import { card, dangerButton, primaryButton } from '../components/styles';
import { usePageAlert } from '../components/usePageAlert';
import { formatDateTime } from '../i18n';

function inviteLink(code: string): string {
  return `${window.location.origin}/register?invite=${encodeURIComponent(code)}`;
}

/** Each field's whole rule, shown instead of zod's per-check messages. */
const INVITE_FIELD_RULES = {
  maxUses: `Must be a whole number between 1 and ${LIMITS.inviteMaxUses}`,
  expiresInHours: `Must be a whole number between 1 and ${LIMITS.inviteMaxExpiresHours}`,
};

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
  const errors = fieldErrors(createMutation.error, INVITE_FIELD_RULES);
  const created = createMutation.data;
  // The page's single alert slot, shared with the app-wide camera and screen share errors. Field
  // problems are shown under their fields instead.
  const slot = usePageAlert(
    failed === createMutation.error
      ? formAlertMessage(failed, Object.keys(INVITE_FIELD_RULES))
      : failed
        ? errorMessage(failed)
        : null,
  );

  return (
    <div className="flex flex-col gap-6">
      {slot.shared && <PageAlert message={slot.message} onDismiss={slot.dismiss} />}
      <section className={`${card} max-md:p-4`} aria-labelledby="invites-create-heading">
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

      <section className={`${card} max-md:p-4`} aria-labelledby="invites-list-heading">
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
          // Below `md` each row is a card (code; uses, expiry; status), with inline labels instead of a header row.
          <div className="mt-4 md:overflow-x-auto">
            <table className="w-full text-left text-sm max-md:block">
              <thead className="text-xs tracking-wide text-muted uppercase max-md:hidden">
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
              <tbody className="divide-y divide-white/5 max-md:block">
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
    <tr
      data-testid="invite-row"
      className="max-md:flex max-md:flex-wrap max-md:items-center max-md:gap-x-4 max-md:gap-y-1 max-md:py-3"
    >
      <td className="py-2 pr-4 max-md:w-full max-md:p-0">
        <span data-testid="invite-code" className="font-mono max-md:break-all">
          {invite.code}
        </span>
      </td>
      <td className="py-2 pr-4 tabular-nums max-md:p-0 max-md:text-xs">
        <span className="text-muted md:hidden">Uses </span>
        {invite.uses} / {invite.maxUses}
      </td>
      <td className="py-2 pr-4 max-md:p-0 max-md:text-xs">
        <span className="text-muted md:hidden">Expires </span>
        <time dateTime={invite.expiresAt}>{formatDateTime(invite.expiresAt)}</time>
        {expired && <span className="ml-2 text-xs text-muted">(expired)</span>}
      </td>
      <td className="py-2 max-md:w-full max-md:p-0">
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
