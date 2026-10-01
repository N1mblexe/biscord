import { LIMITS, type BootstrapResponse, type Channel, type ChannelType } from '@hearth/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type SubmitEvent } from 'react';
import {
  bootstrapQuery,
  bootstrapQueryKey,
  createChannel,
  deleteChannel,
  renameChannel,
  reorderChannels,
} from '../api/chat';
import { errorMessage, fieldErrors, formAlertMessage, type FieldErrors } from '../api/errors';
import { FormAlert, FormSuccess, formString, PageAlert, TextField } from '../components/forms';
import { card, dangerButton, inputClass, primaryButton, secondaryButton } from '../components/styles';
import { usePageAlert } from '../components/usePageAlert';
import { removeChannel, replaceChannels, upsertChannel } from '../lib/bootstrapPatch';
import { Trans, useT, type TFunction } from '../i18n';
import { useMessageStore } from '../stores/messages';

/** A channel type's label ("Text", "Voice"). */
function typeLabel(type: ChannelType, t: TFunction): string {
  return t(`admin.channels.types.${type}`);
}

/** The alert for a failed create or rename: CONFLICT here means the name is taken. */
function channelFormAlert(err: unknown, t: TFunction): string | null {
  return formAlertMessage(err, ['name'], { CONFLICT: t('admin.channels.nameTaken') });
}

const smallButton = `${secondaryButton} px-2 py-1 text-xs`;

const dangerSolidButton =
  'inline-flex items-center justify-center rounded-lg bg-danger px-4 py-2 text-sm font-semibold text-white ' +
  'transition hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 ' +
  'focus-visible:outline-danger disabled:cursor-not-allowed disabled:opacity-50';

function isChannelType(value: string): value is ChannelType {
  return value === 'text' || value === 'voice';
}

export function AdminChannelsPage() {
  const t = useT();
  const queryClient = useQueryClient();
  const { data: boot, error: bootError, isPending: bootPending } = useQuery(bootstrapQuery);
  const channels = boot?.channels ?? [];

  const patch = (fn: (boot: BootstrapResponse) => BootstrapResponse) => {
    queryClient.setQueryData<BootstrapResponse>(bootstrapQueryKey, (old) => (old ? fn(old) : old));
  };

  // One alert for the page: the most recent failure of any action (shown in the dialog while it's open).
  const [alert, setAlert] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  // The rename form's VALIDATION messages (e.g. an empty name), shown under its input.
  const [renameErrors, setRenameErrors] = useState<FieldErrors>({});
  const [deleting, setDeleting] = useState<Channel | null>(null);

  const createMutation = useMutation({
    mutationFn: createChannel,
    onSuccess: (channel) => {
      patch((b) => upsertChannel(b, channel));
    },
  });

  /**
   * Runs an action with the page's single alert: cleared before, set on failure (to `alertFor(err)`,
   * which may leave it empty when the problem is shown next to a field instead).
   */
  const run = async (
    action: () => Promise<void>,
    alertFor: (err: unknown) => string | null = errorMessage,
  ): Promise<boolean> => {
    setAlert(null);
    createMutation.reset();
    setBusy(true);
    try {
      await action();
      return true;
    } catch (err) {
      setAlert(alertFor(err));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const onCreate = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const type = formString(data, 'type');
    setAlert(null);
    createMutation.mutate(
      { name: formString(data, 'name').trim(), type: isChannelType(type) ? type : 'text' },
      {
        onSuccess: () => {
          form.reset();
        },
      },
    );
  };

  const onRename = async (channel: Channel, name: string) => {
    const trimmed = name.trim();
    setRenameErrors({});
    if (trimmed === channel.name) {
      setRenamingId(null);
      return;
    }
    const ok = await run(
      async () => {
        const updated = await renameChannel(channel.id, trimmed);
        patch((b) => upsertChannel(b, updated));
      },
      (err) => {
        setRenameErrors(fieldErrors(err));
        return channelFormAlert(err, t);
      },
    );
    if (ok) setRenamingId(null);
  };

  const closeRename = () => {
    setRenameErrors({});
    setRenamingId(null);
  };

  const onMove = (index: number, delta: -1 | 1) => {
    const ids = channels.map((c) => c.id);
    const target = index + delta;
    const moving = ids[index];
    const other = ids[target];
    if (moving === undefined || other === undefined) return;
    ids[index] = other;
    ids[target] = moving;
    void run(async () => {
      const reordered = await reorderChannels(ids);
      patch((b) => replaceChannels(b, reordered));
    });
  };

  const onDelete = async (channel: Channel) => {
    const ok = await run(async () => {
      await deleteChannel(channel.id);
      patch((b) => removeChannel(b, channel.id));
      useMessageStore.getState().forgetChannel(channel.id);
    });
    if (ok) setDeleting(null);
  };

  // The page's single alert slot, shared with the app-wide camera and screen share errors. While the
  // delete dialog is open (modal, the rest of the page is inert) it shows the slot instead.
  const slot = usePageAlert(createMutation.isError ? channelFormAlert(createMutation.error, t) : alert);
  const errors = fieldErrors(createMutation.error);

  return (
    <div className="flex flex-col gap-6">
      {deleting === null && slot.shared && <PageAlert message={slot.message} onDismiss={slot.dismiss} />}
      <section className={`${card} max-md:p-4`} aria-labelledby="channels-create-heading">
        <h1 id="channels-create-heading" className="text-2xl font-semibold tracking-tight">
          {t('admin.channels.heading')}
        </h1>
        <p className="mt-1 text-sm text-muted">
          {t('admin.channels.description', { max: LIMITS.maxChannels })}
        </p>
        <form className="mt-4 flex flex-col gap-4" onSubmit={onCreate} noValidate>
          <div className="grid max-w-md grid-cols-1 gap-4 sm:grid-cols-[1fr_auto]">
            <TextField
              id="channel-name"
              name="name"
              label={t('admin.channels.name')}
              autoComplete="off"
              maxLength={32}
              errors={errors}
            />
            <div className="flex flex-col gap-1.5">
              <label htmlFor="channel-type" className="text-sm font-medium text-text">
                {t('admin.channels.type')}
              </label>
              <select id="channel-type" name="type" className={inputClass} defaultValue="text">
                <option value="text">{typeLabel('text', t)}</option>
                <option value="voice">{typeLabel('voice', t)}</option>
              </select>
            </div>
          </div>
          {deleting === null && !slot.shared && <FormAlert message={slot.message} />}
          {createMutation.isSuccess && (
            <FormSuccess>
              {t('admin.channels.created', {
                name: `${createMutation.data.type === 'text' ? '#' : ''}${createMutation.data.name}`,
              })}
            </FormSuccess>
          )}
          <div>
            <button type="submit" className={primaryButton} disabled={createMutation.isPending}>
              {t('admin.channels.submit')}
            </button>
          </div>
        </form>
      </section>

      <section className={`${card} max-md:p-4`} aria-labelledby="channels-list-heading">
        <h2 id="channels-list-heading" className="text-lg font-semibold">
          {t('admin.channels.listHeading')}
        </h2>
        {bootPending ? (
          <p className="mt-4 text-sm text-muted">{t('admin.channels.loading')}</p>
        ) : bootError ? (
          <p className="mt-4 text-sm text-danger">{errorMessage(bootError)}</p>
        ) : channels.length === 0 ? (
          <p className="mt-4 text-sm text-muted">{t('admin.channels.empty')}</p>
        ) : (
          <ul className="mt-4 divide-y divide-white/5">
            {channels.map((channel, index) => (
              <li
                key={channel.id}
                data-testid="channel-row"
                className="flex flex-wrap items-center gap-3 py-2"
              >
                {renamingId === channel.id ? (
                  <RenameForm
                    channel={channel}
                    busy={busy}
                    errors={renameErrors.name}
                    onSave={(name) => {
                      void onRename(channel, name);
                    }}
                    onCancel={closeRename}
                  />
                ) : (
                  <span className="min-w-0 flex-1 truncate text-sm">
                    <span data-testid="channel-row-name" className="font-medium">
                      {channel.name}
                    </span>
                    <span className="ml-2 text-xs text-muted">{typeLabel(channel.type, t)}</span>
                  </span>
                )}
                <div className="flex flex-wrap gap-1.5">
                  {renamingId !== channel.id && (
                    <button
                      type="button"
                      className={smallButton}
                      onClick={() => {
                        setAlert(null);
                        setRenameErrors({});
                        setRenamingId(channel.id);
                      }}
                    >
                      {t('admin.channels.rename')}
                    </button>
                  )}
                  <button
                    type="button"
                    className={smallButton}
                    disabled={busy || index === 0}
                    onClick={() => {
                      onMove(index, -1);
                    }}
                  >
                    {t('admin.channels.moveUp')}
                  </button>
                  <button
                    type="button"
                    className={smallButton}
                    disabled={busy || index === channels.length - 1}
                    onClick={() => {
                      onMove(index, 1);
                    }}
                  >
                    {t('admin.channels.moveDown')}
                  </button>
                  <button
                    type="button"
                    className={dangerButton}
                    onClick={() => {
                      setAlert(null);
                      createMutation.reset();
                      setDeleting(channel);
                    }}
                  >
                    {t('admin.channels.delete')}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {deleting && (
        <DeleteChannelDialog
          channel={deleting}
          busy={busy}
          alert={slot.message}
          onConfirm={() => {
            void onDelete(deleting);
          }}
          onClose={() => {
            setAlert(null);
            setDeleting(null);
          }}
        />
      )}
    </div>
  );
}

interface RenameFormProps {
  channel: Channel;
  busy: boolean;
  /** VALIDATION messages for the name. */
  errors: string[] | undefined;
  onSave: (name: string) => void;
  onCancel: () => void;
}

function RenameForm({ channel, busy, errors, onSave, onCancel }: RenameFormProps) {
  const t = useT();
  const inputId = `rename-${channel.id}`;
  const errorId = `${inputId}-error`;
  return (
    <form
      className="flex min-w-0 flex-1 flex-wrap items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        onSave(formString(new FormData(event.currentTarget), 'name'));
      }}
    >
      <label htmlFor={inputId} className="sr-only">
        {t('admin.channels.newName')}
      </label>
      <input
        id={inputId}
        name="name"
        className={`${inputClass} max-w-xs py-1`}
        defaultValue={channel.name}
        maxLength={32}
        autoComplete="off"
        autoFocus
        aria-invalid={errors ? true : undefined}
        aria-describedby={errors ? errorId : undefined}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onCancel();
        }}
      />
      <button type="submit" className={`${primaryButton} px-3 py-1 text-xs`} disabled={busy}>
        {t('common.save')}
      </button>
      <button type="button" className={smallButton} onClick={onCancel}>
        {t('common.cancel')}
      </button>
      {errors && (
        <p id={errorId} className="basis-full text-xs text-danger">
          {errors.join(' ')}
        </p>
      )}
    </form>
  );
}

interface DeleteChannelDialogProps {
  channel: Channel;
  busy: boolean;
  alert: string | null;
  onConfirm: () => void;
  onClose: () => void;
}

function DeleteChannelDialog({ channel, busy, alert, onConfirm, onClose }: DeleteChannelDialogProps) {
  const t = useT();
  const ref = useRef<HTMLDialogElement>(null);
  const [typed, setTyped] = useState('');

  useEffect(() => {
    const dialog = ref.current;
    // Guarded for StrictMode's double effect run. Unmounting removes the dialog, which closes it; an
    // explicit close() here would queue a `close` event and dismiss the remounted dialog.
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  const matches = typed === channel.name;

  return (
    <dialog
      ref={ref}
      aria-labelledby="delete-channel-heading"
      className="m-auto w-full max-w-md rounded-2xl bg-surface p-6 text-text shadow-xl ring-1 ring-white/10 backdrop:bg-black/60"
      onClose={onClose}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (matches && !busy) onConfirm();
        }}
      >
        <h2 id="delete-channel-heading" className="text-lg font-semibold">
          {t('admin.channels.deleteDialog.title', { name: channel.name })}
        </h2>
        <p className="text-sm text-muted">
          <Trans
            k="admin.channels.deleteDialog.body"
            params={{ name: channel.name }}
            components={{ name: (c) => <span className="font-mono text-text">{c}</span> }}
          />
        </p>
        <TextField
          id="delete-channel-confirm"
          name="confirm"
          label={t('admin.channels.deleteDialog.confirmLabel')}
          autoComplete="off"
          value={typed}
          onChange={(event) => {
            setTyped(event.target.value);
          }}
        />
        <FormAlert message={alert} />
        <div className="flex justify-end gap-2">
          <button
            type="button"
            className={secondaryButton}
            onClick={() => {
              ref.current?.close();
            }}
          >
            {t('common.cancel')}
          </button>
          <button type="submit" className={dangerSolidButton} disabled={!matches || busy}>
            {t('admin.channels.deleteDialog.submit')}
          </button>
        </div>
      </form>
    </dialog>
  );
}
