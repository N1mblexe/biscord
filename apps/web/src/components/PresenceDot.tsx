import { useT } from '../i18n';

/** Online/offline status dot (members list, DM links). */
export function PresenceDot({ online }: { online: boolean }) {
  const t = useT();
  const label = t(online ? 'a11y.online' : 'a11y.offline');
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={`size-2 shrink-0 rounded-full ${online ? 'bg-success' : 'bg-muted/40 ring-1 ring-muted/60 ring-inset'}`}
    />
  );
}
