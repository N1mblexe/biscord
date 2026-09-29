import { afterEach, describe, expect, it } from 'vitest';
import { newerAlert, nextAlertStamp, pickPageAlert, usePageAlertStore } from './pageAlert';

afterEach(() => {
  usePageAlertStore.getState().clear();
});

describe('page alert', () => {
  it('the newer of a page message and an app-wide one is shown', () => {
    const page = { message: 'Upload failed', at: nextAlertStamp() };
    usePageAlertStore.getState().show('Screen share was cancelled or blocked');
    const shared = usePageAlertStore.getState().alert;
    expect(newerAlert(page, shared)?.message).toBe('Screen share was cancelled or blocked');
    const later = { message: 'Upload failed again', at: nextAlertStamp() };
    expect(newerAlert(later, shared)?.message).toBe('Upload failed again');
    expect(newerAlert(null, null)).toBeNull();
    usePageAlertStore.getState().clear();
    expect(usePageAlertStore.getState().alert).toBeNull();
  });

  it('counts the pages that host it', () => {
    const unhost = usePageAlertStore.getState().host();
    expect(usePageAlertStore.getState().hosts).toBe(1);
    unhost();
    expect(usePageAlertStore.getState().hosts).toBe(0);
  });

  it('a slot shows exactly one message and says whose it is', () => {
    expect(pickPageAlert(null, null)).toEqual({ message: null, shared: false });

    const formError = { message: 'Your current password is wrong.', at: nextAlertStamp() };
    expect(pickPageAlert(formError, null)).toEqual({ message: formError.message, shared: false });

    // A media error after the form error takes the slot (the page shows it in its top slot).
    usePageAlertStore.getState().show('Camera is unavailable or blocked');
    const media = usePageAlertStore.getState().alert;
    expect(pickPageAlert(formError, media)).toEqual({
      message: 'Camera is unavailable or blocked',
      shared: true,
    });
    expect(pickPageAlert(null, media)).toEqual({ message: 'Camera is unavailable or blocked', shared: true });

    // A newer form error takes it back (shown in its form); the media one isn't shown as well.
    const retry = { message: 'Display name is required.', at: nextAlertStamp() };
    expect(pickPageAlert(retry, media)).toEqual({ message: retry.message, shared: false });
  });

  it('a second app-wide message replaces the first, and clear empties the slot', () => {
    usePageAlertStore.getState().show('Camera is unavailable or blocked');
    usePageAlertStore.getState().show('Screen share was cancelled or blocked');
    expect(pickPageAlert(null, usePageAlertStore.getState().alert).message).toBe(
      'Screen share was cancelled or blocked',
    );
    usePageAlertStore.getState().clear();
    expect(pickPageAlert(null, usePageAlertStore.getState().alert)).toEqual({ message: null, shared: false });
  });
});
