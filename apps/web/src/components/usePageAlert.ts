import { useCallback, useEffect, useState } from 'react';
import {
  newerAlert,
  nextAlertStamp,
  pickPageAlert,
  usePageAlertStore,
  type PageAlertSlot,
  type StampedAlert,
} from '../stores/pageAlert';

/** The page's derived message and when it last changed (`alert` is null once dismissed). */
interface Derived {
  source: string | null;
  alert: StampedAlert | null;
}

/**
 * A page's single alert: its own messages merged with the app-wide ones (camera and screen share
 * errors, stores/pageAlert.ts); the newer one is shown, and `shared` says which it is. A page's own
 * message comes from `pageMessage` (derived from its state, e.g. a failed mutation; stamped when it
 * changes) and/or `setAlert`. Dismissing clears all of them. Every page in the signed-in layout
 * uses this, so the layout's fallback never adds a second `role="alert"`.
 */
export function usePageAlert(pageMessage: string | null = null): PageAlertSlot & {
  setAlert: (message: string | null) => void;
  dismiss: () => void;
} {
  const [local, setLocal] = useState<StampedAlert | null>(null);
  const [derived, setDerived] = useState<Derived>({ source: null, alert: null });
  const shared = usePageAlertStore((s) => s.alert);

  // A new page message is newer than anything shown so far (adjusting state while rendering).
  if (derived.source !== pageMessage) {
    setDerived({
      source: pageMessage,
      alert: pageMessage === null ? null : { message: pageMessage, at: nextAlertStamp() },
    });
  }

  useEffect(() => usePageAlertStore.getState().host(), []);

  const setAlert = useCallback((message: string | null) => {
    setLocal(message === null ? null : { message, at: nextAlertStamp() });
  }, []);
  const dismiss = useCallback(() => {
    setLocal(null);
    setDerived((d) => ({ ...d, alert: null }));
    usePageAlertStore.getState().clear();
  }, []);

  return { ...pickPageAlert(newerAlert(local, derived.alert), shared), setAlert, dismiss };
}
