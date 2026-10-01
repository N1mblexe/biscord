import type { MessagesOf } from '../en';

export const chat: MessagesOf<'chat'> = {
  edited: '(düzenlendi)',
  channel: {
    dropFiles: 'Eklemek için dosyaları bırakın',
    readOnlyDm: 'Bu konuşma salt okunur.',
    placeholderChannel: '#{channel} kanalına mesaj gönder',
    placeholderDm: '{name} adlı kişiye mesaj gönder',
  },
  composer: {
    label: 'Mesaj',
    attachments: 'Ekler',
    attachFiles: 'Dosya ekle',
    send: 'Gönder',
    chipUploading: 'Yükleniyor…',
    chipFailed: 'Başarısız',
    removeFile: '{filename} dosyasını kaldır',
  },
  message: {
    actions: 'Mesaj işlemleri',
    edit: 'Düzenle',
    delete: 'Sil',
    confirmDelete: 'Bu mesaj silinsin mi?',
    editLabel: 'Mesajı düzenle',
    save: 'Kaydet',
    cancel: 'İptal',
    editHint: 'Kaydetmek için Enter · İptal için Escape',
    notSent: 'Gönderilmedi',
    sending: 'Gönderiliyor…',
    retry: 'Tekrar dene',
    discard: 'Vazgeç',
    tooLong: 'Mesajlar en fazla {max} karakter olabilir.',
  },
  history: {
    label: 'Sohbet geçmişi',
    loadOlder: 'Daha eski mesajları yükle',
    loadError: 'Mesajlar yüklenemedi: {error}',
    retry: 'Tekrar dene',
    beginning: 'Konuşmanın başlangıcı burası.',
    // Turkish nouns stay singular after a number.
    newMessages: { one: '{shown} yeni mesaj', other: '{shown} yeni mesaj' },
    jumpToLatest: 'En yeniye git',
  },
  reactions: {
    label: 'Tepkiler',
    add: 'Tepki ekle',
  },
  attachment: {
    fileLabel: '{filename} ({size})',
    tooLarge: 'Dosya çok büyük (en fazla {max}).',
    tooMany: 'Bir mesaja en fazla {max} dosya ekleyebilirsiniz.',
  },
  typing: {
    one: '{a} yazıyor…',
    two: '{a} ve {b} yazıyor…',
    several: 'Birkaç kişi yazıyor…',
  },
  empty: {
    noChannelsTitle: 'Henüz kanal yok',
    noChannelsAdmin: 'Herkesin konuşabileceği bir yer için ilk metin kanalını oluşturun.',
    noChannelsMember:
      'Bir yönetici henüz metin kanalı oluşturmadı. Yine de üye listesinden birine direkt mesaj gönderebilirsiniz.',
    channelTitle: '#{channel} kanalına hoş geldiniz',
    channelBody: 'Burada henüz bir şey yok. İlk mesajı siz yazın!',
    dmTitle: '{name} ile konuşmanızın başlangıcı',
    dmBody: 'Merhaba deyin — bunu yalnızca ikiniz görebilirsiniz.',
    noDmsTitle: 'Henüz konuşma yok',
    noDmsBody: 'Üye listesinde birinin yanındaki Mesaj düğmesiyle bir konuşma başlatın.',
  },
  notice: {
    channelDeleted: 'Bu kanal silindi.',
    channelUnavailable: 'Bu kanal yok ya da erişim izniniz yok.',
    voiceChannelNoText: 'Ses kanallarında metin sohbeti yok. Katılmak için kenar çubuğunda birine tıklayın.',
  },
};
