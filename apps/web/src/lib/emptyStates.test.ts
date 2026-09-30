import { describe, expect, it } from 'vitest';
import { emptyChannelCopy, NO_DMS_COPY, noChannelsCopy } from './emptyStates';

describe('noChannelsCopy', () => {
  it('invites an admin to create the first channel', () => {
    expect(noChannelsCopy(true).body).toMatch(/Create the first text channel/);
  });

  it('tells a member to ask an admin and points at DMs', () => {
    const { title, body } = noChannelsCopy(false);
    expect(title).toBe('No channels yet');
    expect(body).toMatch(/admin/);
    expect(body).toMatch(/message someone directly/);
    expect(body).not.toMatch(/Create the first/);
  });
});

describe('emptyChannelCopy', () => {
  it('names a text channel with #', () => {
    expect(emptyChannelCopy('general', false)).toEqual({
      title: 'Welcome to #general',
      body: 'Nothing here yet. Be the first to say something!',
    });
  });

  it('names the other person in a DM', () => {
    const { title, body } = emptyChannelCopy('Bob', true);
    expect(title).toBe('This is the start of your conversation with Bob');
    expect(body).toMatch(/only the two of you/);
  });
});

describe('NO_DMS_COPY', () => {
  it('explains how to start a DM', () => {
    expect(NO_DMS_COPY.body).toMatch(/Message button/);
  });
});
