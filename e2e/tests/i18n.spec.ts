import type { BrowserContext, Locator, Page } from '@playwright/test';
import type { UserResponse } from '@hearth/shared';
import { api, displayNameFor, expect, NEEDS_TEST_MODE, passwordFor, test } from '../fixtures.js';
import { isFullStack } from '../env.js';

/**
 * Language switching (CONTRACTS B.11, docs/plans/i18n.md "Verification → e2e"). The rest of the suite
 * runs in `en-US` and asserts the English copy; this spec is the only one that looks at Turkish.
 * Turkish strings are copied from apps/web/src/i18n/messages/tr/*.ts.
 */

const TR = {
  username: 'Kullanıcı adı',
  password: 'Şifre',
  loginSubmit: 'Giriş yap',
  loginTitle: 'Tekrar hoş geldiniz',
  inviteCode: 'Davet kodu',
  displayName: 'Görünen ad',
  registerSubmit: 'Hesap oluştur',
  welcome: (name: string) => `Hoş geldiniz, ${name}`,
  languageHeading: 'Dil',
  languageUpdated: 'Dil güncellendi.',
  profileHeading: 'Profil',
  saveProfile: 'Profili kaydet',
} as const;

const EN = {
  username: 'Username',
  password: 'Password',
  loginSubmit: 'Log in',
  loginTitle: 'Welcome back',
  languageHeading: 'Language',
  languageUpdated: 'Language updated.',
  profileHeading: 'Profile',
  saveProfile: 'Save profile',
} as const;

const LANGUAGE_STORAGE_KEY = 'hearth:language';

function field(page: Page, label: string): Locator {
  return page.getByLabel(label, { exact: true });
}

function button(page: Page, name: string): Locator {
  return page.getByRole('button', { name, exact: true });
}

function languageSelect(page: Page): Locator {
  return page.getByTestId('language-select');
}

async function expectHtmlLang(page: Page, lang: 'en' | 'tr'): Promise<void> {
  await expect(page.locator('html')).toHaveAttribute('lang', lang);
}

async function storedLanguage(page: Page): Promise<string | null> {
  return page.evaluate((key) => globalThis.localStorage.getItem(key), LANGUAGE_STORAGE_KEY);
}

async function expectLoginPage(page: Page, copy: typeof TR | typeof EN): Promise<void> {
  await expect(field(page, copy.username)).toBeVisible();
  await expect(field(page, copy.password)).toBeVisible();
  await expect(button(page, copy.loginSubmit)).toBeVisible();
  await expect(page.getByRole('heading', { name: copy.loginTitle, exact: true })).toBeVisible();
}

/** The Settings Language section: heading text and the select's current value. */
async function expectSettingsLanguage(page: Page, locale: 'en' | 'tr'): Promise<void> {
  const copy = locale === 'tr' ? TR : EN;
  await expect(page.getByTestId('settings-language-heading')).toHaveText(copy.languageHeading);
  await expect(languageSelect(page)).toHaveValue(locale);
  await expect(page.getByRole('heading', { name: copy.profileHeading, exact: true })).toBeVisible();
  await expect(button(page, copy.saveProfile)).toBeVisible();
  await expectHtmlLang(page, locale);
}

async function meLocale(page: Page): Promise<string> {
  const res = await api(page.request).get<UserResponse>('/api/me');
  expect(res.status, 'GET /api/me').toBe(200);
  return res.body.user.locale;
}

/** Waits for the Settings language save (`PATCH /api/me`) triggered by `action`. */
async function savingLanguage(page: Page, action: () => Promise<unknown>): Promise<void> {
  const saved = page.waitForResponse(
    (res) => res.request().method() === 'PATCH' && new URL(res.url()).pathname === '/api/me',
  );
  await action();
  expect((await saved).status(), 'PATCH /api/me').toBe(200);
}

test.describe('i18n', { tag: '@i18n' }, () => {
  test('1. the login page switches to Türkçe and keeps it after a reload', async ({ newPage }) => {
    const page = await newPage();
    await page.goto('/login');
    await expectLoginPage(page, EN);
    await expectHtmlLang(page, 'en');
    await expect(languageSelect(page)).toHaveValue('en');
    await expect(languageSelect(page).locator('option')).toHaveText(['English', 'Türkçe']);

    await languageSelect(page).selectOption({ label: 'Türkçe' });
    await expectLoginPage(page, TR);
    await expectHtmlLang(page, 'tr');
    await expect(languageSelect(page)).toHaveValue('tr');
    expect(await storedLanguage(page)).toBe('tr');

    await page.reload();
    await expectLoginPage(page, TR);
    await expectHtmlLang(page, 'tr');
    await expect(languageSelect(page)).toHaveValue('tr');

    // The choice carries over to the other public pages.
    await page.goto('/register');
    await expect(field(page, TR.inviteCode)).toBeVisible();
    await expect(button(page, TR.registerSubmit)).toBeVisible();
  });

  test('2. registering while Turkish is shown stores locale tr on the account', async ({
    adminInviteCode,
    newPage,
  }) => {
    test.skip(isFullStack, NEEDS_TEST_MODE);
    const page = await newPage();
    await page.goto(`/register?invite=${encodeURIComponent(adminInviteCode)}`);
    await languageSelect(page).selectOption('tr');
    await expectHtmlLang(page, 'tr');

    await expect(field(page, TR.inviteCode)).toHaveValue(adminInviteCode);
    await field(page, TR.username).fill('alice');
    await field(page, TR.displayName).fill(displayNameFor('alice'));
    await field(page, TR.password).fill(passwordFor('alice'));
    await button(page, TR.registerSubmit).click();

    await expect(page.getByTestId('home-welcome')).toHaveText(TR.welcome(displayNameFor('alice')));
    await expect(page.getByTestId('socket-status')).toHaveText('connected');
    await expectHtmlLang(page, 'tr');
    expect(await meLocale(page)).toBe('tr');
  });

  test('3. switching to Türkçe in Settings applies at once and follows the account', async ({
    browser,
    users,
  }) => {
    test.skip(isFullStack, NEEDS_TEST_MODE);
    const { alice } = await users(['alice']);
    expect(await meLocale(alice.page)).toBe('en');

    await alice.page.goto('/settings');
    await expectSettingsLanguage(alice.page, 'en');

    await savingLanguage(alice.page, () => languageSelect(alice.page).selectOption({ label: 'Türkçe' }));
    await expectSettingsLanguage(alice.page, 'tr');
    await expect(alice.page.getByText(TR.languageUpdated, { exact: true })).toBeVisible();
    expect(await meLocale(alice.page)).toBe('tr');

    await alice.page.reload();
    await expectSettingsLanguage(alice.page, 'tr');

    // A brand-new context (empty storage, en-US) logged into the same account gets Turkish from the
    // account, not from this browser.
    let fresh: BrowserContext | undefined;
    try {
      fresh = await browser.newContext({ locale: 'en-US' });
      const page = await fresh.newPage();
      await page.goto('/login');
      await expectLoginPage(page, EN);
      expect(await storedLanguage(page)).toBeNull();

      await field(page, EN.username).fill(alice.username);
      await field(page, EN.password).fill(alice.password);
      await button(page, EN.loginSubmit).click();
      await expect(page.getByTestId('home-welcome')).toHaveText(TR.welcome(alice.displayName));
      await expectHtmlLang(page, 'tr');

      await page.goto('/settings');
      await expectSettingsLanguage(page, 'tr');
    } finally {
      await fresh?.close();
    }
  });

  test('4. switching back to English restores the English labels', async ({ users }) => {
    test.skip(isFullStack, NEEDS_TEST_MODE);
    const { alice } = await users(['alice']);
    const patched = await api(alice.request).patch<UserResponse>('/api/me', { locale: 'tr' });
    expect(patched.status, 'PATCH /api/me').toBe(200);

    await alice.page.goto('/settings');
    await expectSettingsLanguage(alice.page, 'tr');

    await savingLanguage(alice.page, () => languageSelect(alice.page).selectOption({ label: 'English' }));
    await expectSettingsLanguage(alice.page, 'en');
    await expect(alice.page.getByText(EN.languageUpdated, { exact: true })).toBeVisible();
    await expect(alice.page.getByText(TR.languageUpdated, { exact: true })).toHaveCount(0);
    expect(await meLocale(alice.page)).toBe('en');

    await alice.page.reload();
    await expectSettingsLanguage(alice.page, 'en');
  });

  test('5. a Turkish browser with nothing stored shows Turkish before login', async ({ browser }) => {
    let context: BrowserContext | undefined;
    try {
      context = await browser.newContext({ locale: 'tr-TR' });
      const page = await context.newPage();
      await page.goto('/login');
      await expectLoginPage(page, TR);
      await expectHtmlLang(page, 'tr');
      await expect(languageSelect(page)).toHaveValue('tr');
      // Detection is a guess, not a choice: it is not written to storage.
      expect(await storedLanguage(page)).toBeNull();
    } finally {
      await context?.close();
    }
  });
});
