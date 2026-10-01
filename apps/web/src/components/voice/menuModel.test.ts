import { describe, expect, it } from 'vitest';
import type { DeviceLists } from '../../voice/devices';
import { deviceChoices, labelsHiddenFor, menuKey } from './menuModel';

const LABELS = {
  default: 'Default',
  numbered: (n: number) => `Microphone ${n}`,
  saved: 'Saved device',
  missing: 'Disconnected device',
};

function lists(patch: Partial<DeviceLists>): DeviceLists {
  return {
    audioinput: [],
    audiooutput: [],
    videoinput: [],
    labelsHidden: false,
    supported: true,
    ...patch,
  };
}

describe('deviceChoices', () => {
  it('puts Default first and folds the browser default pseudo-device into it', () => {
    const choices = deviceChoices(
      [
        { deviceId: 'default', label: 'Default - Built-in' },
        { deviceId: 'a', label: 'Built-in' },
        { deviceId: 'b', label: 'Headset' },
      ],
      'default',
      LABELS,
    );
    expect(choices).toEqual([
      { value: 'default', label: 'Default' },
      { value: 'a', label: 'Built-in' },
      { value: 'b', label: 'Headset' },
    ]);
  });

  it('numbers unlabelled devices in list order', () => {
    const choices = deviceChoices(
      [
        { deviceId: 'default', label: '' },
        { deviceId: 'a', label: '' },
        { deviceId: 'b', label: '' },
      ],
      'b',
      LABELS,
    );
    expect(choices.map((c) => c.label)).toEqual(['Default', 'Microphone 1', 'Microphone 2']);
  });

  it('keeps the saved device as a choice when it is not listed', () => {
    expect(deviceChoices([], 'x', LABELS)).toEqual([
      { value: 'default', label: 'Default' },
      { value: 'x', label: 'Saved device' },
    ]);
    expect(deviceChoices([{ deviceId: 'a', label: 'A' }], 'x', LABELS).at(-1)).toEqual({
      value: 'x',
      label: 'Disconnected device',
    });
  });

  it('adds nothing extra when the saved device is listed or is the default', () => {
    expect(deviceChoices([{ deviceId: 'a', label: 'A' }], 'a', LABELS)).toHaveLength(2);
    expect(deviceChoices([], 'default', LABELS)).toHaveLength(1);
  });
});

describe('labelsHiddenFor', () => {
  it('is false when names are shown or the API is missing', () => {
    expect(labelsHiddenFor(lists({}), ['audioinput'])).toBe(false);
    expect(labelsHiddenFor(lists({ labelsHidden: true, supported: false }), ['audioinput'])).toBe(false);
  });

  it('is true for a kind with no listed or unnamed devices', () => {
    const hidden = lists({
      labelsHidden: true,
      audioinput: [{ deviceId: 'a', label: 'Mic' }],
      audiooutput: [{ deviceId: 'o', label: 'Speakers' }],
    });
    expect(labelsHiddenFor(hidden, ['audioinput', 'audiooutput'])).toBe(false);
    expect(labelsHiddenFor(hidden, ['videoinput'])).toBe(true);
    const unnamed = lists({ labelsHidden: true, videoinput: [{ deviceId: 'c', label: '' }] });
    expect(labelsHiddenFor(unnamed, ['videoinput'])).toBe(true);
  });
});

describe('menuKey', () => {
  it('moves with the arrows and wraps', () => {
    expect(menuKey('ArrowDown', 0, 3)).toEqual({ type: 'focus', index: 1 });
    expect(menuKey('ArrowDown', 2, 3)).toEqual({ type: 'focus', index: 0 });
    expect(menuKey('ArrowUp', 0, 3)).toEqual({ type: 'focus', index: 2 });
    expect(menuKey('ArrowUp', 2, 3)).toEqual({ type: 'focus', index: 1 });
  });

  it('enters from nowhere at the first or last item', () => {
    expect(menuKey('ArrowDown', -1, 3)).toEqual({ type: 'focus', index: 0 });
    expect(menuKey('ArrowUp', -1, 3)).toEqual({ type: 'focus', index: 2 });
  });

  it('jumps with Home and End', () => {
    expect(menuKey('Home', 2, 4)).toEqual({ type: 'focus', index: 0 });
    expect(menuKey('End', 0, 4)).toEqual({ type: 'focus', index: 3 });
  });

  it('activates with Enter and Space on an item only', () => {
    expect(menuKey('Enter', 1, 3)).toEqual({ type: 'activate' });
    expect(menuKey(' ', 1, 3)).toEqual({ type: 'activate' });
    expect(menuKey('Enter', -1, 3)).toBeNull();
  });

  it('closes with Escape and Tab, even when empty', () => {
    expect(menuKey('Escape', 0, 3)).toEqual({ type: 'close' });
    expect(menuKey('Tab', 0, 3)).toEqual({ type: 'close' });
    expect(menuKey('Escape', -1, 0)).toEqual({ type: 'close' });
  });

  it('leaves other keys alone', () => {
    expect(menuKey('a', 0, 3)).toBeNull();
    expect(menuKey('ArrowLeft', 0, 3)).toBeNull();
    expect(menuKey('ArrowDown', -1, 0)).toBeNull();
  });
});
