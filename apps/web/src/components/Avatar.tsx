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
}

/**
 * `data-testid="avatar"`: the user's image, or their initials on a stable color when there is none
 * (or it fails to load). Decorative: the name is always shown next to it, so `alt` is empty.
 */
export function Avatar({ userId, name, avatarUrl, size = 'md' }: AvatarProps) {
  // The URL that failed to load; a new URL (`?v=` changes on every upload) is tried again.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const base = `${SIZES[size]} shrink-0 rounded-full`;

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

/** An avatar with the presence dot on its corner (members list, DM links). */
export function AvatarWithPresence({ online, ...avatar }: AvatarProps & { online: boolean }) {
  return (
    <span className="relative inline-flex shrink-0">
      <Avatar {...avatar} />
      <span className="absolute -right-0.5 -bottom-0.5 flex rounded-full bg-surface p-[2px]">
        <PresenceDot online={online} />
      </span>
    </span>
  );
}
