import type { MessagesOf } from '../en';

export const common: MessagesOf<'common'> = {
  appName: 'Hearth',
  loading: 'Yükleniyor…',
  tagline: 'Arkadaşlarınızla vakit geçirmeniz için özel bir yer.',
  cancel: 'İptal',
  save: 'Kaydet',
  dismissError: 'Hatayı kapat',
  language: {
    label: 'Dil',
    en: 'English',
    tr: 'Türkçe',
  },
  // Turkish nouns stay singular after a number, so both forms read the same.
  memberCount: { one: '{count} üye', other: '{count} üye' },
  home: {
    welcome: 'Hoş geldiniz, {name}',
    pickChannel: 'Bir kanal seçin',
    pickChannelBody:
      'Sohbete başlamak için kenar çubuğundan bir kanal seçin ya da üye listesinden birine mesaj gönderin.',
    createFirstChannel: 'İlk kanalı oluştur',
  },
  routeError: {
    notFoundTitle: 'Sayfa bulunamadı',
    notFoundDetail: 'Bu adreste hiçbir şey yok.',
    unreachableTitle: 'Hearth sunucusuna ulaşılamıyor',
    unreachableDetail: 'Sunucuya ulaşılamıyor. Bağlantınızı kontrol edip tekrar deneyin.',
    genericTitle: 'Bir şeyler ters gitti',
    genericDetail: 'Beklenmeyen bir hata oluştu. Lütfen tekrar deneyin.',
    goHome: 'Ana sayfaya git',
    tryAgain: 'Tekrar dene',
  },
};
