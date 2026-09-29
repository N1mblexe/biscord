import type { Attachment } from '@hearth/shared';
import { attachmentView, fileLabel, isAttachmentUrl } from '../../lib/attachments';

function FileIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className="size-4 shrink-0 opacity-70" fill="none">
      <path
        d="M4 1.5h5L12.5 5v9.5h-8.5z M9 1.5V5h3.5"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * A message's attachments (docs/plans/phase-5.md, "Web UI contract"): allowlisted images inline
 * (`attachment-image`, lazy, size-capped, opening the original in a new tab), everything else as a
 * download link `attachment-file` with its name and size.
 */
export function AttachmentList({ attachments }: { attachments: readonly Attachment[] }) {
  if (attachments.length === 0) return null;
  return (
    <ul className="mt-1 flex flex-col items-start gap-1.5">
      {attachments.map((attachment) => (
        <li key={attachment.id} className="max-w-full">
          <AttachmentView attachment={attachment} />
        </li>
      ))}
    </ul>
  );
}

function AttachmentView({ attachment }: { attachment: Attachment }) {
  const { url, filename } = attachment;
  if (!isAttachmentUrl(url)) {
    return <span className="text-sm text-muted">{fileLabel(attachment)}</span>;
  }
  if (attachmentView(attachment) === 'image') {
    return (
      <a href={url} target="_blank" rel="noopener noreferrer" className="block w-fit">
        <img
          data-testid="attachment-image"
          src={url}
          alt={filename}
          title={filename}
          loading="lazy"
          className="block max-h-80 max-w-full rounded-md bg-surface-raised object-contain sm:max-w-sm"
        />
      </a>
    );
  }
  return (
    <a
      data-testid="attachment-file"
      href={url}
      download={filename}
      className="flex max-w-full items-center gap-2 rounded-md bg-surface-raised px-3 py-2 text-sm text-accent ring-1 ring-white/10 hover:underline"
    >
      <FileIcon />
      <span className="truncate">{fileLabel(attachment)}</span>
    </a>
  );
}
