import { describe, expect, it } from 'vitest';
import { normalizeUsername } from './username';

describe('normalizeUsername', () => {
  it('trims and lower-cases', () => {
    expect(normalizeUsername('  Alice_01 ')).toBe('alice_01');
    expect(normalizeUsername('BOB')).toBe('bob');
    expect(normalizeUsername('\tcarol\n')).toBe('carol');
  });

  it('leaves an already normalised name alone and keeps inner characters as typed', () => {
    expect(normalizeUsername('dave')).toBe('dave');
    expect(normalizeUsername('Bad Name')).toBe('bad name'); // still rejected by the server's VALIDATION
    expect(normalizeUsername('')).toBe('');
  });
});
