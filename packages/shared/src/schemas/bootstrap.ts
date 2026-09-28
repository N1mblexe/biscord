import { z } from 'zod';
import { Uuid } from '../ids.js';
import { Channel, DmChannel } from './channels.js';
import { ReadState } from './messages.js';
import { Me, PublicUser } from './users.js';
import { VoiceParticipant } from './voice.js';

/** GET `/bootstrap` */
export const BootstrapResponse = z.object({
  me: Me,
  users: z.array(PublicUser),
  channels: z.array(Channel),
  dms: z.array(DmChannel),
  readStates: z.array(ReadState),
  /** Keyed by voice channel id. */
  voice: z.record(Uuid, z.array(VoiceParticipant)),
  onlineUserIds: z.array(Uuid),
  livekitUrl: z.string(),
});
export type BootstrapResponse = z.infer<typeof BootstrapResponse>;
