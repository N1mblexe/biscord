import { z } from 'zod';
import { Uuid } from '../ids.js';
import { ChannelName, ChannelType } from './common.js';

export const Channel = z.object({
  id: Uuid,
  type: ChannelType,
  name: ChannelName,
  position: z.number().int(),
});
export type Channel = z.infer<typeof Channel>;

export const DmChannel = z.object({
  id: Uuid,
  type: z.literal('dm'),
  otherUserId: Uuid,
});
export type DmChannel = z.infer<typeof DmChannel>;

/** POST `/channels` */
export const CreateChannelRequest = z.object({
  type: ChannelType,
  name: ChannelName,
});
export type CreateChannelRequest = z.infer<typeof CreateChannelRequest>;

/** PATCH `/channels/:id` */
export const UpdateChannelRequest = z.object({ name: ChannelName });
export type UpdateChannelRequest = z.infer<typeof UpdateChannelRequest>;

/** PUT `/channels/order` — every non-DM channel id, in the new order. */
export const ReorderChannelsRequest = z.object({
  ids: z.array(Uuid).refine((ids) => new Set(ids).size === ids.length, { error: 'ids must be unique' }),
});
export type ReorderChannelsRequest = z.infer<typeof ReorderChannelsRequest>;

export const ChannelResponse = z.object({ channel: Channel });
export type ChannelResponse = z.infer<typeof ChannelResponse>;

export const ChannelsResponse = z.object({ channels: z.array(Channel) });
export type ChannelsResponse = z.infer<typeof ChannelsResponse>;

/** POST `/dms` */
export const CreateDmRequest = z.object({ userId: Uuid });
export type CreateDmRequest = z.infer<typeof CreateDmRequest>;

export const DmChannelResponse = z.object({ channel: DmChannel });
export type DmChannelResponse = z.infer<typeof DmChannelResponse>;
