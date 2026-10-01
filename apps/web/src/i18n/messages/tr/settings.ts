import type { MessagesOf } from '../en';

export const settings: MessagesOf<'settings'> = {
  title: 'Ayarlar',
  profile: {
    heading: 'Profil',
    signedInAs: '<mono>{username}</mono> olarak giriş yaptınız',
    displayName: 'Görünen ad',
    saved: 'Profil kaydedildi.',
    submit: 'Profili kaydet',
  },
  avatar: {
    heading: 'Avatar',
    description: 'En fazla {size} boyutunda PNG, JPEG ya da WebP görsel.',
    label: 'Avatar',
    updated: 'Avatar güncellendi.',
    removed: 'Avatar kaldırıldı.',
    remove: 'Avatarı kaldır',
  },
  password: {
    heading: 'Şifre',
    description: 'Şifrenizi değiştirdiğinizde diğer tüm cihazlardaki oturumlarınız kapanır.',
    current: 'Mevcut şifre',
    new: 'Yeni şifre',
    placeholder: 'en az 10 karakter',
    changed: 'Şifre değiştirildi.',
    submit: 'Şifreyi değiştir',
    wrongCurrent: 'Mevcut şifreniz yanlış.',
  },
  notifications: {
    heading: 'Bildirimler',
    description:
      'Hearth arka plandayken biri sizden bahsettiğinde ya da size direkt mesaj gönderdiğinde masaüstü bildirimi alın.',
    label: 'Masaüstü bildirimleri',
    denied: 'Bu site için bildirimler engellenmiş. Tarayıcı ayarlarınızdan izin verip tekrar deneyin.',
    default: 'Bildirimlere izin verilmedi.',
    unsupported: 'Bu tarayıcı masaüstü bildirimlerini desteklemiyor.',
    channelTitle: '#{channel} kanalında {author}',
  },
  language: {
    heading: 'Dil',
    description: 'Hesabınıza kaydedilir; giriş yaptığınız her cihazda geçerli olur.',
    updated: 'Dil güncellendi.',
  },
};
