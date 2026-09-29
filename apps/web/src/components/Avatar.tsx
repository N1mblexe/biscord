import { useState } from 'react';
import { avatarColor, initials } from '../lib/avatar';
import { PresenceDot } from './PresenceDot';

const SIZES = {
  xs: 'size-5 text-[9px]',
  sm: 'size-6 text-[10px]',
  md: 'size-9 text-sm',
  lg: 'size-16 text-xl',
} as const;

interface AvatarProps {
  /** Seeds the initials color, so a user keeps the same color everywhere. */
  userId: string;
  /** The name shown next to the avatar (initials come from it). */
  name: string;
  avatarUrl: string | null;
  size?: keyof typeof SIZES;
  /** A deactivated user ("Deleted user"): the neutral avatar, whatever `avatarUrl` is. */
  deleted?: boolean;
}

/** A generic person silhouette for deleted users. */
function PersonIcon() {
  return (
    <svg viewBox="0 0 16 16" className="size-3/5" fill="currentColor" aria-hidden="true">
      <circle cx="8" cy="5.5" r="3" />
      <path d="M2.5 14.5a5.5 5.5 0 0 1 11 0z" />
    </svg>
  );
}

/**
 * `data-testid="avatar"`: the user's image, or their initials on a stable color when there is none
 * (or it fails to load); a neutral silhouette (`data-deleted="true"`) for a deleted user.
 * Decorative: the name is always shown next to it, so `alt` is empty.
 */
export function Avatar({ userId, name, avatarUrl, size = 'md', deleted = false }: AvatarProps) {
  // The URL that failed to load; a new URL (`?v=` changes on every upload) is tried again.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const base = `${SIZES[size]} shrink-0 rounded-full`;

  if (deleted) {
    return (
      <span
        data-testid="avatar"
        data-deleted="true"
        aria-hidden="true"
        className={`${base} inline-flex items-center justify-center bg-surface-raised text-muted ring-1 ring-white/10 select-none`}
      >
        <PersonIcon />
      </span>
    );
  }

  if (avatarUrl !== null && avatarUrl !== failedUrl) {
    return (
      <img
        data-testid="avatar"
        src={avatarUrl}
        alt=""
        className={`${base} bg-surface-raised object-cover`}
        draggable={false}
        onError={() => {
          setFailedUrl(avatarUrl);
        }}
      />
    );
  }
  return (
    <span
      data-testid="avatar"
      aria-hidden="true"
      className={`${base} inline-flex items-center justify-center font-semibold text-bg select-none`}
      style={{ backgroundColor: avatarColor(userId) }}
    >
      {initials(name)}
    </span>
  );
}

/**
 * An avatar with the presence dot on its corner (members list, DM links). The dot sits centred on
 * the bounding box's bottom-right corner, i.e. mostly outside the circle, with a ring in the panel
 * colour to separate it, so it never covers two-letter initials, even on the smallest avatars.
 */
export function AvatarWithPresence({ online, ...avatar }: AvatarProps & { online: boolean }) {
  return (
    <span className="relative inline-flex shrink-0">
      <Avatar {...avatar} />
      <span className="absolute right-0 bottom-0 flex translate-x-1/3 translate-y-1/3 rounded-full ring-2 ring-surface">
        <PresenceDot online={online} />
      </span>
    </span>
  );
}
