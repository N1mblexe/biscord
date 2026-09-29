import { describe, expect, it } from 'vitest';

/**
 * No page in the signed-in layout can show two `role="alert"`s: each one that renders an alert
 * routes it through its single slot (`usePageAlert`), which also makes the layout's `FallbackAlert`
 * stand down. The public pages (outside `AppLayout`) never receive app-wide alerts.
 */
const sources = import.meta.glob<string>('./*.tsx', { query: '?raw', import: 'default', eager: true });

const PUBLIC_PAGES = ['./LoginPage.tsx', './RegisterPage.tsx', './ResetPasswordPage.tsx', './RouteError.tsx'];
const SIGNED_IN_PAGES = [
  './HomePage.tsx',
  './ChannelPage.tsx',
  './SettingsPage.tsx',
  './AdminChannelsPage.tsx',
  './AdminInvitesPage.tsx',
  './AdminUsersPage.tsx',
];

function rendersAlert(source: string): boolean {
  return /<(FormAlert|PageAlert)\b/.test(source);
}

describe('one alert per page', () => {
  it('every signed-in page that renders an alert uses the single page-alert slot', () => {
    for (const page of SIGNED_IN_PAGES) {
      const source = sources[page];
      expect(source, page).toBeDefined();
      expect(source?.includes('usePageAlert('), `${page} uses usePageAlert`).toBe(true);
    }
  });

  it('no other page renders an alert unaccounted for', () => {
    const known = new Set([...PUBLIC_PAGES, ...SIGNED_IN_PAGES, './AppLayout.tsx']);
    const unknown = Object.entries(sources)
      .filter(([path, source]) => !known.has(path) && rendersAlert(source))
      .map(([path]) => path);
    expect(unknown).toEqual([]);
  });
});
