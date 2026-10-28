import type { SVGProps } from 'react';

type P = SVGProps<SVGSVGElement> & { size?: number };

const base = ({ size = 20, ...p }: P) => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  ...p,
});

export const IconPlay = (p: P) => (
  <svg {...base(p)}><path d="M7 4.5v15l12.5-7.5z" fill="currentColor" stroke="none" /></svg>
);
export const IconPause = (p: P) => (
  <svg {...base(p)}><rect x="6" y="4.5" width="4" height="15" rx="1" fill="currentColor" stroke="none" /><rect x="14" y="4.5" width="4" height="15" rx="1" fill="currentColor" stroke="none" /></svg>
);
export const IconStop = (p: P) => (
  <svg {...base(p)}><rect x="5.5" y="5.5" width="13" height="13" rx="2" fill="currentColor" stroke="none" /></svg>
);
export const IconPrev = (p: P) => (
  <svg {...base(p)}><path d="M18 5v14L8 12z" fill="currentColor" stroke="none" /><path d="M6 5v14" /></svg>
);
export const IconNext = (p: P) => (
  <svg {...base(p)}><path d="M6 5v14l10-7z" fill="currentColor" stroke="none" /><path d="M18 5v14" /></svg>
);
export const IconLoop = (p: P) => (
  <svg {...base(p)}><path d="M17 2l4 4-4 4" /><path d="M3 11v-1a4 4 0 0 1 4-4h14" /><path d="M7 22l-4-4 4-4" /><path d="M21 13v1a4 4 0 0 1-4 4H3" /></svg>
);
export const IconSettings = (p: P) => (
  <svg {...base(p)}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></svg>
);
export const IconLibrary = (p: P) => (
  <svg {...base(p)}><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></svg>
);
export const IconPlus = (p: P) => (
  <svg {...base(p)}><path d="M12 5v14M5 12h14" /></svg>
);
export const IconX = (p: P) => (
  <svg {...base(p)}><path d="M18 6 6 18M6 6l12 12" /></svg>
);
export const IconFade = (p: P) => (
  <svg {...base(p)}><path d="M3 6h4l14 12" /><path d="M3 18h18" opacity=".4" /></svg>
);
export const IconUpload = (p: P) => (
  <svg {...base(p)}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="M17 8l-5-5-5 5" /><path d="M12 3v12" /></svg>
);
export const IconEdit = (p: P) => (
  <svg {...base(p)}><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>
);
export const IconTrash = (p: P) => (
  <svg {...base(p)}><path d="M3 6h18" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6M14 11v6" /><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" /></svg>
);
export const IconMic = (p: P) => (
  <svg {...base(p)}><rect x="9" y="2" width="6" height="12" rx="3" /><path d="M19 10v2a7 7 0 0 1-14 0v-2" /><path d="M12 19v3" /></svg>
);
export const IconChords = (p: P) => (
  <svg {...base(p)}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /><path d="M8 13h8" /><path d="M8 17h6" /></svg>
);
export const IconSparkles = (p: P) => (
  <svg {...base(p)}><path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z" /></svg>
);
export const IconMidi = (p: P) => (
  <svg {...base(p)}><rect x="2" y="6" width="20" height="12" rx="2" /><path d="M6 12h.01M10 12h.01M14 12h.01M18 12h.01" /></svg>
);
export const IconRouting = (p: P) => (
  <svg {...base(p)}><circle cx="6" cy="6" r="2" /><circle cx="18" cy="6" r="2" /><circle cx="6" cy="18" r="2" /><circle cx="18" cy="18" r="2" /><path d="M8 6h8M8 18h8M6 8v8" /></svg>
);
export const IconLogo = (p: P) => (
  <svg {...base(p)} viewBox="0 0 32 32" stroke="none">
    <rect width="32" height="32" rx="8" fill="#2f80ed" />
    <rect x="7" y="13" width="3" height="9" rx="1.5" fill="#fff" />
    <rect x="12" y="8" width="3" height="16" rx="1.5" fill="#fff" />
    <rect x="17" y="11" width="3" height="11" rx="1.5" fill="#fff" />
    <rect x="22" y="15" width="3" height="6" rx="1.5" fill="#fff" />
  </svg>
);
