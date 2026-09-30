/** Copy for the friendly empty states (components/EmptyState.tsx). */
export interface EmptyCopy {
  title: string;
  body: string;
}

/** The server has no text channels yet. Admins can fix that; members can only ask (or DM). */
export function noChannelsCopy(isAdmin: boolean): EmptyCopy {
  return isAdmin
    ? {
        title: 'No channels yet',
        body: 'Create the first text channel so everyone has somewhere to talk.',
      }
    : {
        title: 'No channels yet',
        body: 'An admin hasn’t created any text channels yet. You can still message someone directly from the members list.',
      };
}

/**
 * A channel or DM with no messages. `name` is the channel name (without `#`) or, for a DM, the other
 * person's display name.
 */
export function emptyChannelCopy(name: string, isDm: boolean): EmptyCopy {
  return isDm
    ? {
        title: `This is the start of your conversation with ${name}`,
        body: 'Say hi — only the two of you can see this.',
      }
    : { title: `Welcome to #${name}`, body: 'Nothing here yet. Be the first to say something!' };
}

/** No direct messages yet (sidebar). */
export const NO_DMS_COPY: EmptyCopy = {
  title: 'No conversations yet',
  body: 'Start one with the Message button next to someone in the members list.',
};
