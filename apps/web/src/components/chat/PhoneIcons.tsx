import type { SVGProps } from "react";

// Sao's fork: lucide has no "phone + arrow" or "phone + pencil", so these are
// drawn on lucide's Smartphone outline in its style (24 grid, stroke 2, round).

type PhoneIconProps = SVGProps<SVGSVGElement>;

function PhoneIconFrame({ children, ...props }: PhoneIconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...props}
    >
      <rect width="14" height="20" x="5" y="2" rx="2" ry="2" />
      <path d="M12 18h.01" />
      {children}
    </svg>
  );
}

/** Send a file to the phone's Downloads. */
export function PhoneDownloadIcon(props: PhoneIconProps) {
  return (
    <PhoneIconFrame {...props}>
      <path d="M12 6v7" />
      <path d="m9 10 3 3 3-3" />
    </PhoneIconFrame>
  );
}

/** Put text on the phone's clipboard. */
export function PhoneClipIcon(props: PhoneIconProps) {
  return (
    <PhoneIconFrame {...props}>
      <path d="m13.5 7 2 2-4.5 4.5-2.5.5.5-2.5z" />
    </PhoneIconFrame>
  );
}
