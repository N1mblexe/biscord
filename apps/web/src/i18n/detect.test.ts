import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { detectInitialLocale, LANGUAGE_STORAGE_KEY, readStoredLocale, writeStoredLocale } from './detect';
import { getLocale, initLocale, useLocaleStore } from './store';

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
  };
}

const blockedStorage = {
  getItem: () => {
    throw new Error('blocked');
  },
  setItem: () => {
    throw new Error('blocked');
  },
};

function stubDocument() {
  const documentElement = { lang: 'en' };
  vi.stubGlobal('document', { documentElement });
  return documentElement;
}

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
  vi.stubGlobal('navigator', { language: 'en-US', languages: ['en-US'] });
});

afterEach(() => {
  vi.unstubAllGlobals();
  useLocaleStore.setState({ locale: 'en' });
});

describe('detectInitialLocale', () => {
  it('prefers the stored choice', () => {
    vi.stubGlobal('localStorage', memoryStorage({ [LANGUAGE_STORAGE_KEY]: 'en' }));
    vi.stubGlobal('navigator', { language: 'tr-TR' });
    expect(detectInitialLocale()).toBe('en');
    vi.stubGlobal('localStorage', memoryStorage({ [LANGUAGE_STORAGE_KEY]: 'tr' }));
    expect(detectInitialLocale()).toBe('tr');
  });

  it('then a Turkish browser language, then English', () => {
    vi.stubGlobal('navigator', { language: 'tr-TR' });
    expect(detectInitialLocale()).toBe('tr');
    vi.stubGlobal('navigator', { language: 'tr' });
    expect(detectInitialLocale()).toBe('tr');
    vi.stubGlobal('navigator', { language: 'de-DE' });
    expect(detectInitialLocale()).toBe('en');
    vi.stubGlobal('navigator', undefined);
    expect(detectInitialLocale()).toBe('en');
  });

  it('ignores an invalid stored value', () => {
    vi.stubGlobal('localStorage', memoryStorage({ [LANGUAGE_STORAGE_KEY]: 'de' }));
    vi.stubGlobal('navigator', { language: 'tr-TR' });
    expect(readStoredLocale()).toBeNull();
    expect(detectInitialLocale()).toBe('tr');
  });

  it('works when storage is blocked', () => {
    vi.stubGlobal('localStorage', blockedStorage);
    expect(readStoredLocale()).toBeNull();
    expect(() => {
      writeStoredLocale('tr');
    }).not.toThrow();
    expect(detectInitialLocale()).toBe('en');
  });
});

describe('locale store', () => {
  it('setLocale saves the choice and updates <html lang>', () => {
    const storage = memoryStorage();
    vi.stubGlobal('localStorage', storage);
    const html = stubDocument();
    useLocaleStore.getState().setLocale('tr');
    expect(getLocale()).toBe('tr');
    expect(html.lang).toBe('tr');
    expect(storage.data.get(LANGUAGE_STORAGE_KEY)).toBe('tr');
    useLocaleStore.getState().setLocale('en');
    expect(html.lang).toBe('en');
    expect(storage.data.get(LANGUAGE_STORAGE_KEY)).toBe('en');
  });

  it('setLocale still switches when storage is blocked', () => {
    vi.stubGlobal('localStorage', blockedStorage);
    const html = stubDocument();
    useLocaleStore.getState().setLocale('tr');
    expect(getLocale()).toBe('tr');
    expect(html.lang).toBe('tr');
  });

  it('initLocale applies the detected language without saving it', () => {
    const storage = memoryStorage();
    vi.stubGlobal('localStorage', storage);
    vi.stubGlobal('navigator', { language: 'tr-TR' });
    const html = stubDocument();
    expect(initLocale()).toBe('tr');
    expect(getLocale()).toBe('tr');
    expect(html.lang).toBe('tr');
    expect(storage.data.has(LANGUAGE_STORAGE_KEY)).toBe(false);
  });
});
