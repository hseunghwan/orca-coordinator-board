/** @jsxImportSource react */
// Lucide glyphs, the icon set Orca draws with.
import type { ReactNode } from "react";

function Icon({ size, className, children }: { size?: number; className?: string; children: ReactNode }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" className={className}>{children}</svg>;
}

type Props = { size?: number; className?: string };
export const ChevronRight = (props: Props) => <Icon {...props}><path d="m9 18 6-6-6-6" /></Icon>;
export const ChevronDown = (props: Props) => <Icon {...props}><path d="m6 9 6 6 6-6" /></Icon>;
export const ChevronUp = (props: Props) => <Icon {...props}><path d="m18 15-6-6-6 6" /></Icon>;
export const CircleCheck = (props: Props) => <Icon {...props}><circle cx="12" cy="12" r="10" /><path d="m9 12 2 2 4-4" /></Icon>;
export const CircleHelp = (props: Props) => <Icon {...props}><circle cx="12" cy="12" r="10" /><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" /><path d="M12 17h.01" /></Icon>;
export const Paperclip = (props: Props) => <Icon {...props}><path d="m16 6-8.414 8.586a2 2 0 0 0 2.829 2.829l8.414-8.586a4 4 0 1 0-5.657-5.657l-8.379 8.551a6 6 0 1 0 8.485 8.485l8.379-8.551" /></Icon>;
export const Loader = (props: Props) => <Icon {...props}><path d="M21 12a9 9 0 1 1-6.219-8.56" /></Icon>;
