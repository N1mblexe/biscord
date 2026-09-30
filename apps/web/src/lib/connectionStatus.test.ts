import { describe, expect, it } from 'vitest';
import { CONNECTION_LABELS, connectionState } from './connectionStatus';

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
    expect(CONNECTION_LABELS).toEqual({
      connected: 'Connected',
      connecting: 'Connecting…',
      reconnecting: 'Reconnecting…',
      offline: 'Offline',
    });
  });
});
