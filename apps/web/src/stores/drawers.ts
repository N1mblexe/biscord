import { create } from 'zustand';

/**
 * The phone layout's off-canvas drawers (below Tailwind's `md`): the sidebar (**Open navigation**)
 * and the members list (**Members**). At most one is open. From `md` up both are ordinary columns and
 * this state is unused (the layout closes any open drawer when the viewport grows past `md`).
 */
export type DrawerId = 'nav' | 'members';

interface DrawerState {
  open: DrawerId | null;
  /** How many mounted pages show a members panel (the header's **Members** button needs one). */
  membersHosts: number;
  show: (id: DrawerId) => void;
  toggle: (id: DrawerId) => void;
  /** Closes whichever drawer is open. */
  close: () => void;
  /** Called by `MembersPanel` on mount; returns the unregister function. */
  hostMembers: () => () => void;
}

export const useDrawerStore = create<DrawerState>()((set) => ({
  open: null,
  membersHosts: 0,
  show: (id) => {
    set((s) => (id === 'members' && s.membersHosts === 0 ? s : { open: id }));
  },
  toggle: (id) => {
    set((s) => {
      if (s.open === id) return { open: null };
      return id === 'members' && s.membersHosts === 0 ? s : { open: id };
    });
  },
  close: () => {
    set((s) => (s.open === null ? s : { open: null }));
  },
  hostMembers: () => {
    set((s) => ({ membersHosts: s.membersHosts + 1 }));
    return () => {
      set((s) => {
        const membersHosts = s.membersHosts - 1;
        // The members drawer can't stay open without a members panel to show.
        return { membersHosts, open: membersHosts === 0 && s.open === 'members' ? null : s.open };
      });
    };
  },
}));
