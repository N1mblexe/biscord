import { describe, expect, it } from 'vitest';
import { tFor } from '../i18n/translate';
import type { MessageKey } from '../i18n/types';
import { connectionLabel, connectionState, type ConnectionState } from './connectionStatus';

const STATES: readonly ConnectionState[] = ['connected', 'connecting', 'reconnecting', 'offline'];

function labels(translate?: (key: MessageKey) => string): Record<string, string> {
  return Object.fromEntries(STATES.map((state) => [state, connectionLabel(state, translate)]));
}

describe('connectionState', () => {
  it('is connected whenever the socket is, even if the browser claims to be offline', () => {
    expect(connectionState({ status: 'connected', online: true, everConnected: true })).toBe('connected');
    expect(connectionState({ status: 'connected', online: false, everConnected: false })).toBe('connected');
  });

  it('is connecting before the first connection', () => {
    expect(connectionState({ status: 'disconnected', online: true, everConnected: false })).toBe(
      'connecting',
    );
  });

  it('is reconnecting after a drop while the network is up', () => {
    expect(connectionState({ status: 'disconnected', online: true, everConnected: true })).toBe(
      'reconnecting',
    );
  });

  it('is offline when the browser has no network', () => {
    expect(connectionState({ status: 'disconnected', online: false, everConnected: true })).toBe('offline');
    expect(connectionState({ status: 'disconnected', online: false, everConnected: false })).toBe('offline');
  });

  it('has a friendly label for every state', () => {
    expect(labels()).toEqual({
      connected: 'Connected',
      connecting: 'Connecting…',
      reconnecting: 'Reconnecting…',
      offline: 'Offline',
    });
  });

  it('translates the label, not the state', () => {
    expect(labels((key) => tFor('tr', key))).toEqual({
      connected: 'Bağlı',
      connecting: 'Bağlanıyor…',
      reconnecting: 'Yeniden bağlanıyor…',
      offline: 'Çevrimdışı',
    });
  });
});
