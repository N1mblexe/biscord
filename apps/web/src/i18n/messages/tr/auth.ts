import type { MessagesOf } from '../en';

export const auth: MessagesOf<'auth'> = {
  username: 'Kullanıcı adı',
  password: 'Şifre',
  newPassword: 'Yeni şifre',
  passwordHint: 'En az 10 karakter.',
  login: {
    title: 'Tekrar hoş geldiniz',
    description: 'Arkadaşlarınızla sohbete katılmak için giriş yapın.',
    haveInvite: 'Davetiniz mi var? <link>Hesap oluşturun</link>',
    gotResetCode: 'Sıfırlama kodunuz mu var? <link>Şifrenizi sıfırlayın</link>',
    submit: 'Giriş yap',
  },
  register: {
    title: 'Hesabınızı oluşturun',
    description: 'Yöneticilerden birinden davet kodu almanız gerekir.',
    haveAccount: 'Zaten hesabınız var mı? <link>Giriş yapın</link>',
    inviteCode: 'Davet kodu',
    usernameHint:
      '3–32 küçük harf (a–z), rakam ya da alt çizgi. Arkadaşlarınız sizden bahsederken bunu @ ile yazar.',
    usernameRule: '3–32 küçük harf (a–z), rakam ya da alt çizgi kullanın',
    displayName: 'Görünen ad',
    displayNameHint: 'Herkesin gördüğü ad. Daha sonra Ayarlar’dan değiştirebilirsiniz.',
    submit: 'Hesap oluştur',
  },
  reset: {
    title: 'Şifrenizi sıfırlayın',
    description: 'Bir yöneticiden sıfırlama kodu isteyin. Kodlar 24 saat geçerlidir.',
    remembered: 'Hatırladınız mı? <link>Girişe dönün</link>',
    code: 'Sıfırlama kodu',
    submit: 'Yeni şifreyi kaydet',
    invalidCredentials: 'Kullanıcı adı ya da sıfırlama kodu yanlış veya kodun süresi dolmuş.',
  },
  notice: {
    logout: 'Çıkış yaptınız.',
    deactivated: 'Hesabınız devre dışı bırakıldı.',
    password_changed: 'Şifreniz değiştirildi. Lütfen tekrar giriş yapın.',
    password_reset: 'Şifreniz sıfırlandı. Lütfen yeni şifrenizle giriş yapın.',
    unauthenticated: 'Oturumunuz sona erdi. Lütfen tekrar giriş yapın.',
    generic: 'Lütfen tekrar giriş yapın.',
  },
};
