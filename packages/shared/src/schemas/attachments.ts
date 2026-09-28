import { z } from 'zod';
import { Uuid } from '../ids.js';

/** `url` = `/api/attachments/:id/:filename`; `inline` = served inline (png/jpeg/gif/webp). */
export const Attachment = z.object({
  id: Uuid,
  filename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  url: z.string(),
  inline: z.boolean(),
});
export type Attachment = z.infer<typeof Attachment>;

/** POST `/attachments` */
export const AttachmentResponse = z.object({ attachment: Attachment });
export type AttachmentResponse = z.infer<typeof AttachmentResponse>;
