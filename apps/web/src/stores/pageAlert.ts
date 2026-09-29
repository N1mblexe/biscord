import { create } from 'zustand';

/**
 * Messages for the page's single `role="alert"` that come from outside the page (docs/plans/
 * phase-7.md: "Screen share was cancelled or blocked", "Camera is unavailable or blocked"). Every
 * page in the signed-in layout shows its own alerts and these through `usePageAlert`, one slot (the
 * newer message wins); a page without one gets these from the layout's fallback (`hosts` = mounted
 * `usePageAlert` users), so no page ever shows two. The layout clears them on route change.
 */

export interface StampedAlert {
  message: string;
  /** Orders this against a page's own message: the newer one is shown. */
  at: number;
}

let lastStamp = 0;

/** A strictly increasing stamp for ordering alerts. */
export function nextAlertStamp(): number {
  lastStamp += 1;
  return lastStamp;
}

interface PageAlertState {
  alert: StampedAlert | null;
  /** How many mounted pages show this store's alert themselves. */
  hosts: number;
  show: (message: string) => void;
  clear: () => void;
  /** Called by `usePageAlert` on mount; returns the unregister function. */
  host: () => () => void;
}

export const usePageAlertStore = create<PageAlertState>()((set) => ({
  alert: null,
  hosts: 0,
  show: (message) => {
    set({ alert: { message, at: nextAlertStamp() } });
  },
  clear: () => {
    set({ alert: null });
  },
  host: () => {
    set((s) => ({ hosts: s.hosts + 1 }));
    return () => {
      set((s) => ({ hosts: s.hosts - 1 }));
    };
  },
}));

/** The newer of two alerts (either may be missing). */
export function newerAlert(a: StampedAlert | null, b: StampedAlert | null): StampedAlert | null {
  if (a === null) return b;
  if (b === null) return a;
  return a.at >= b.at ? a : b;
}

/** What a page's single alert slot shows. */
export interface PageAlertSlot {
  message: string | null;
  /**
   * True when `message` is the app-wide one (the page shows it in its top slot, dismissible); false
   * when it is the page's own (shown where the page puts its own alert).
   */
  shared: boolean;
}

/** The page's single alert: the newer of its own message and the app-wide one. */
export function pickPageAlert(own: StampedAlert | null, shared: StampedAlert | null): PageAlertSlot {
  const shown = newerAlert(own, shared);
  return { message: shown?.message ?? null, shared: shown !== null && shown === shared };
}
