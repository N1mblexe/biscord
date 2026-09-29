/** Online/offline status dot (members list, DM links). */
export function PresenceDot({ online }: { online: boolean }) {
  return (
    <span
      role="img"
      aria-label={online ? 'Online' : 'Offline'}
      title={online ? 'Online' : 'Offline'}
      className={`size-2 shrink-0 rounded-full ${online ? 'bg-success' : 'bg-muted/40 ring-1 ring-muted/60 ring-inset'}`}
    />
  );
}
