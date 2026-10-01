import type { BootstrapResponse, Message } from '@hearth/shared';
import { t } from '../i18n/translate';
import { authorName } from './bootstrapPatch';

/**
 * Desktop notifications (docs/plans/phase-4.md, "Notifications"): a `message:created` from someone
 * else that mentions me (every DM message does, CONTRACTS B.5a rule 1) while the tab is hidden.
 * Permission and visibility are read when the event arrives.
 */

/** localStorage key of the Settings toggle: `'on'` when enabled. */
export const NOTIFICATIONS_PREF_KEY = 'hearth:desktop-notifications';

export const PREVIEW_MAX_CHARS = 120;

export function readNotificationsPref(): boolean {
  try {
    return localStorage.getItem(NOTIFICATIONS_PREF_KEY) === 'on';
  } catch {
    return false;
  }
}

export function writeNotificationsPref(enabled: boolean): void {
  try {
    if (enabled) localStorage.setItem(NOTIFICATIONS_PREF_KEY, 'on');
    else localStorage.removeItem(NOTIFICATIONS_PREF_KEY);
  } catch {
    // Storage unavailable (private mode, blocked): the toggle just doesn't persist.
  }
}

export type PermissionState = NotificationPermission | 'unsupported';

function notificationsSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export function notificationPermission(): PermissionState {
  return notificationsSupported() ? Notification.permission : 'unsupported';
}

/** Asks for permission if it hasn't been decided yet; resolves to the resulting state. */
export async function requestNotificationPermission(): Promise<PermissionState> {
  const current = notificationPermission();
  if (current !== 'default') return current;
  try {
    return await Notification.requestPermission();
  } catch {
    return notificationPermission();
  }
}

export interface NotifyDecision {
  message: Message;
  meId: string;
  /** The Settings toggle. */
  enabled: boolean;
  permission: PermissionState;
  visibility: DocumentVisibilityState;
}

/** Whether a `message:created` should show a desktop notification. */
export function shouldNotify({ message, meId, enabled, permission, visibility }: NotifyDecision): boolean {
  return (
    enabled &&
    permission === 'granted' &&
    visibility === 'hidden' &&
    message.authorId !== meId &&
    message.mentionUserIds.includes(meId)
  );
}

/** `<author> in #<channel>` for a channel, `<author>` for a DM. */
export function notificationTitle(boot: BootstrapResponse, message: Message): string {
  const author = authorName(boot.users.find((u) => u.id === message.authorId));
  const channel = boot.channels.find((c) => c.id === message.channelId);
  return channel ? t('settings.notifications.channelTitle', { author, channel: channel.name }) : author;
}

/** The first `max` characters of a message with its Markdown syntax crudely stripped. */
export function plainTextPreview(content: string, max = PREVIEW_MAX_CHARS): string {
  const text = content
    .replace(/```[^\n]*\n?/g, '') // code fences (keep the code)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1') // links and images → their text
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, '') // headings, quotes, list markers
    .replace(/(\*\*|__|~~|`)/g, '') // bold, strikethrough, code spans
    .replace(/(^|[^\w*])\*(?=\S)|(?<=\S)\*(?![\w*])/g, '$1') // *emphasis*
    .replace(/\s+/g, ' ')
    .trim();
  const chars = Array.from(text);
  return chars.length > max ? chars.slice(0, max).join('') : text;
}

/**
 * Shows the notification for `message` if `shouldNotify` says so. Clicking it focuses the window
 * and opens the channel.
 */
export function maybeNotify(message: Message, boot: BootstrapResponse, navigate: (to: string) => void): void {
  if (typeof document === 'undefined') return;
  const decision: NotifyDecision = {
    message,
    meId: boot.me.id,
    enabled: readNotificationsPref(),
    permission: notificationPermission(),
    visibility: document.visibilityState,
  };
  if (!shouldNotify(decision)) return;
  try {
    const notification = new Notification(notificationTitle(boot, message), {
      body: plainTextPreview(message.content),
      tag: `message-${message.id}`,
    });
    notification.onclick = () => {
      window.focus();
      navigate(`/channels/${message.channelId}`);
      notification.close();
    };
  } catch {
    // Some browsers (e.g. Chrome on Android) only allow notifications from a service worker.
  }
}
