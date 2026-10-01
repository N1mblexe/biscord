import { create } from 'zustand';
import { t } from '../i18n/translate';

/**
 * The app-wide notice (`data-testid="app-notice"`), e.g. "This channel was deleted.".
 * Set right before sending the user to `/`; the `/` loader then stays on `/` so the notice is seen,
 * and opening a channel clears it.
 */
interface NoticeState {
  notice: string | null;
  setNotice: (notice: string) => void;
  clearNotice: () => void;
}

export const useNoticeStore = create<NoticeState>()((set) => ({
  notice: null,
  setNotice: (notice) => {
    set({ notice });
  },
  clearNotice: () => {
    set({ notice: null });
  },
}));

/**
 * The notice texts, in the UI language: each getter translates when it is read, so read one right
 * before `setNotice` (a copy taken at module load would stay in the language of that moment). A
 * notice already shown keeps its language when the language changes.
 */
export const NOTICES = {
  get channelDeleted(): string {
    return t('chat.notice.channelDeleted');
  },
  get channelUnavailable(): string {
    return t('chat.notice.channelUnavailable');
  },
  get voiceChannelNoText(): string {
    return t('chat.notice.voiceChannelNoText');
  },
  /** `voice:kicked` (CONTRACTS B.7b rule 4), reason `admin`. */
  get voiceKickedByAdmin(): string {
    return t('chat.notice.voiceKickedByAdmin');
  },
  /** `voice:kicked`, reason `channel_deleted`. */
  get voiceChannelDeleted(): string {
    return t('chat.notice.voiceChannelDeleted');
  },
};
