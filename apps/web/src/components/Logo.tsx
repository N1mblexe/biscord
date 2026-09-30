/**
 * Hearth's mark: a small flame in an accent tile. Decorative (`aria-hidden`); the wordmark "Hearth"
 * is always written next to it as real text.
 */
export function LogoMark({ className = 'size-10' }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-flex shrink-0 items-center justify-center rounded-xl bg-accent/15 text-accent ring-1 ring-accent/30 ${className}`}
    >
      <svg viewBox="0 0 24 24" className="size-3/5" fill="none">
        <path
          d="M12 3c.6 3-1.8 4.6-3.3 6.6C7.4 11.3 7 12.6 7 14a5 5 0 0 0 10 0c0-2.2-1-3.6-2-4.8-.3 1.3-1 2.2-2 2.6.4-3.2-.2-6.3-1-8.8Z"
          fill="currentColor"
          fillOpacity="0.25"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinejoin="round"
        />
        <path
          d="M12 19a2.3 2.3 0 0 1-2.3-2.3c0-1.3 1-2 1.7-3 .4 1 .9 1.4 1.6 1.7.8.4 1.3 1 1.3 1.6A2.3 2.3 0 0 1 12 19Z"
          fill="currentColor"
        />
      </svg>
    </span>
  );
}
