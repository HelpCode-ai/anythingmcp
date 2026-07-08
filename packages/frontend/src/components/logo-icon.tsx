/* AnythingMCP brand mark — single source of truth.
   Uses currentColor so callers control the tint (set text-[var(--brand)]). */
export function LogoIcon({ size = 28 }: { size?: number }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 52 52"
      width={size}
      height={size}
      fill="none"
      aria-hidden="true"
    >
      <line x1="26" y1="26" x2="26" y2="9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" style={{ opacity: 0.55 }} />
      <line x1="26" y1="26" x2="10" y2="40" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" style={{ opacity: 0.55 }} />
      <line x1="26" y1="26" x2="42" y2="40" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" style={{ opacity: 0.55 }} />
      <circle cx="26" cy="9" r="5" fill="currentColor" style={{ opacity: 0.65 }} />
      <circle cx="10" cy="40" r="5" fill="currentColor" style={{ opacity: 0.65 }} />
      <circle cx="42" cy="40" r="5" fill="currentColor" style={{ opacity: 0.65 }} />
      <circle cx="26" cy="26" r="10" fill="currentColor" />
      <circle cx="26" cy="26" r="5.5" fill="white" />
    </svg>
  );
}
