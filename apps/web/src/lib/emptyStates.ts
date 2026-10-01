import { t } from '../i18n/translate';

/** Copy for the friendly empty states (components/EmptyState.tsx), in the UI language. */
export interface EmptyCopy {
  title: string;
  body: string;
}

/** The server has no text channels yet. Admins can fix that; members can only ask (or DM). */
export function noChannelsCopy(isAdmin: boolean): EmptyCopy {
  return {
    title: t('chat.empty.noChannelsTitle'),
    body: isAdmin ? t('chat.empty.noChannelsAdmin') : t('chat.empty.noChannelsMember'),
  };
}

/**
 * A channel or DM with no messages. `name` is the channel name (without `#`) or, for a DM, the other
 * person's display name.
 */
export function emptyChannelCopy(name: string, isDm: boolean): EmptyCopy {
  return isDm
    ? { title: t('chat.empty.dmTitle', { name }), body: t('chat.empty.dmBody') }
    : { title: t('chat.empty.channelTitle', { channel: name }), body: t('chat.empty.channelBody') };
}

/** No direct messages yet (sidebar), in the UI language. */
export function noDmsCopy(): EmptyCopy {
  return { title: t('chat.empty.noDmsTitle'), body: t('chat.empty.noDmsBody') };
}

/**
 * The same as `noDmsCopy()`, kept for existing callers: the getters translate on every read, so
 * `NO_DMS_COPY.title` is always in the current language.
 */
export const NO_DMS_COPY: EmptyCopy = {
  get title() {
    return t('chat.empty.noDmsTitle');
  },
  get body() {
    return t('chat.empty.noDmsBody');
  },
};
