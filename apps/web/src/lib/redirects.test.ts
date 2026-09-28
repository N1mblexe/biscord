import { describe, expect, it } from 'vitest';
import { loginPathFor, safeNext } from './redirects';

describe('safeNext', () => {
  it('keeps same-origin app paths, with their query', () => {
    expect(safeNext('/settings')).toBe('/settings');
    expect(safeNext('/admin/invites?x=1')).toBe('/admin/invites?x=1');
  });

  it('falls back to / for missing or unsafe values', () => {
    expect(safeNext(null)).toBe('/');
    expect(safeNext(undefined)).toBe('/');
    expect(safeNext('')).toBe('/');
    expect(safeNext('settings')).toBe('/');
    expect(safeNext('https://evil.example/')).toBe('/');
    expect(safeNext('//evil.example/')).toBe('/');
    expect(safeNext('/\\evil.example/')).toBe('/');
    expect(safeNext('/\tsettings')).toBe('/');
  });

  it('never sends a user back to a public auth page', () => {
    expect(safeNext('/login')).toBe('/');
    expect(safeNext('/login?next=%2Fsettings')).toBe('/');
    expect(safeNext('/register?invite=ABC')).toBe('/');
    expect(safeNext('/reset-password')).toBe('/');
  });
});

describe('loginPathFor', () => {
  it('encodes the page to come back to', () => {
    expect(loginPathFor('/settings')).toBe('/login?next=%2Fsettings');
    expect(loginPathFor('/admin/invites?a=1&b=2')).toBe('/login?next=%2Fadmin%2Finvites%3Fa%3D1%26b%3D2');
  });

  it('omits next for the home page', () => {
    expect(loginPathFor('/')).toBe('/login');
  });

  it('round-trips through URLSearchParams and safeNext', () => {
    const path = '/admin/users/reset?x=a b';
    const url = new URL(loginPathFor(path), 'http://localhost');
    expect(safeNext(url.searchParams.get('next'))).toBe(path);
  });
});
