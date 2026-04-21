/**
 * Shared spinning loading indicator.
 *
 * A small CSS-animated circle that communicates "something is in
 * progress" without needing any external icon library. Sized via the
 * `size` prop (Tailwind width/height classes) and inherits the parent
 * text colour via `currentColor`.
 *
 * Usage:
 *   <Spinner />
 *   <Spinner size="h-5 w-5" className="text-accent" />
 */
export function Spinner({
  size = "h-4 w-4",
  className,
  testId,
}: {
  /** Tailwind width + height classes, e.g. `"h-3 w-3"`. */
  size?: string;
  className?: string;
  testId?: string;
}) {
  return (
    <svg
      aria-hidden="true"
      data-testid={testId}
      viewBox="0 0 24 24"
      fill="none"
      className={`shrink-0 animate-spin ${size}${className ? ` ${className}` : ""}`}
    >
      <circle
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="3"
        strokeOpacity="0.25"
      />
      <path
        d="M22 12a10 10 0 0 1-10 10"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}
