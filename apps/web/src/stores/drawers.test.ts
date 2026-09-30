import { afterEach, describe, expect, it } from 'vitest';
import { useDrawerStore } from './drawers';

afterEach(() => {
  useDrawerStore.setState({ open: null, membersHosts: 0 });
});

const state = () => useDrawerStore.getState();

describe('drawers', () => {
  it('opens one drawer at a time and toggles it closed', () => {
    const unhost = state().hostMembers();
    state().toggle('nav');
    expect(state().open).toBe('nav');
    // Opening the other drawer replaces it.
    state().toggle('members');
    expect(state().open).toBe('members');
    state().toggle('members');
    expect(state().open).toBeNull();
    state().show('nav');
    state().close();
    expect(state().open).toBeNull();
    unhost();
  });

  it('opens the members drawer only while a page hosts a members panel', () => {
    state().toggle('members');
    expect(state().open).toBeNull();
    state().show('members');
    expect(state().open).toBeNull();

    const unhost = state().hostMembers();
    expect(state().membersHosts).toBe(1);
    state().show('members');
    expect(state().open).toBe('members');
    // The page goes away (e.g. to Settings): the drawer closes with it.
    unhost();
    expect(state().membersHosts).toBe(0);
    expect(state().open).toBeNull();
  });

  it('keeps the members drawer open while another host remains (StrictMode remount, page swap)', () => {
    const first = state().hostMembers();
    const second = state().hostMembers();
    state().show('members');
    first();
    expect(state().open).toBe('members');
    second();
    expect(state().open).toBeNull();
  });

  it('a members host leaving does not close the navigation drawer', () => {
    const unhost = state().hostMembers();
    state().show('nav');
    unhost();
    expect(state().open).toBe('nav');
  });
});
