import type { MessagesOf } from '../en';

export const common: MessagesOf<'common'> = {
  appName: 'Hearth',
  loading: 'Yükleniyor…',
  language: {
    label: 'Dil',
    en: 'English',
    tr: 'Türkçe',
  },
  // Turkish nouns stay singular after a number, so both forms read the same.
  memberCount: { one: '{count} üye', other: '{count} üye' },
};
