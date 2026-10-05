import type { ReactNode } from "react";

const shapes = {
  zoomIn: <><circle cx="10" cy="10" r="7" /><path d="m15 15 6 6M7 10h6M10 7v6" /></>,
  zoomOut: <><circle cx="10" cy="10" r="7" /><path d="m15 15 6 6M7 10h6" /></>,
  rotate: <><path d="M20 8V3l-3 3a8 8 0 1 0 3 8M15 8h5" /></>,
  flipHorizontal: <><path d="M12 3v18M8 6 3 18h5zM16 6l5 12h-5z" /></>,
  flipVertical: <><path d="M3 12h18M6 8 18 3v5zM6 16l12 5v-5z" /></>,
  list: <path d="M9 6h12M9 12h12M9 18h12M3 6h.01M3 12h.01M3 18h.01" />,
  trash: <path d="M4 7h16M9 7V3h6v4M6 7l1 14h10l1-14M10 11v6M14 11v6" />,
  paper: <><path d="M4 3h16v18H4zM8 7h8M8 11h8M8 15h3M8 18h3M14 15h2v3h-2z" /></>,
  immersive: <path d="M9 3H3v6M15 3h6v6M3 15v6h6M21 15v6h-6" />,
  document: <><path d="M6 3h8l4 4v14H6zM14 3v5h4" /></>,
  folder: <path d="M3 7V5h7l2 2h9v13H3z" />,
  search: <><circle cx="10.5" cy="10.5" r="7" /><path d="m16 16 5 5" /></>,
  quickSearch: <><circle cx="9.5" cy="10" r="6.5" /><path d="m14.5 15 4.2 4.2M18.5 3.5l.7 2.1 2.1.7-2.1.7-.7 2.1-.7-2.1-2.1-.7 2.1-.7z" /></>,
  star: <path d="m12 3 2.8 5.8 6.4.9-4.6 4.5 1.1 6.4L12 17.6l-5.7 3 1.1-6.4-4.6-4.5 6.4-.9z" />,
  map: <><circle cx="12" cy="5" r="3" /><circle cx="5" cy="19" r="3" /><circle cx="19" cy="19" r="3" /><path d="m10.5 7.5-4 9m7-9 4 9M8 19h8" /></>,
  import: <><path d="M5 4h14l3 14v3H2v-3zM12 6v10m-4-4 4 4 4-4" /></>,
  help: <><circle cx="12" cy="12" r="9" /><path d="M9 9a3 3 0 0 1 6 0c0 2-3 2-3 5m0 3h.01" /></>,
  shield: <path d="m12 3 9 4v6c0 4-5 7-9 9-4-2-9-5-9-9V7zM8 12l3 3 5-6" />,
  settings: <><path d="m10 3-.5 3-2 .9L5 5.5 2.5 10l2.5 1.5v2L2.5 15 5 19.5l2.5-1.4 2 .9.5 3h4l.5-3 2-.9 2.5 1.4 2.5-4.5-2.5-1.5v-2L21.5 10 19 5.5l-2.5 1.4-2-.9L14 3z" /><circle cx="12" cy="13" r="3" /></>,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  plus: <path d="M12 4v16M4 12h16" />,
  chevron: <path d="m9 5 7 7-7 7" />,
  panelRight: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M16 4v16" /></>,
  panel: <><rect x="3" y="4" width="18" height="16" rx="1" /><path d="M9 4v16" /></>,
  edit: <path d="m15 4 5 5M4 20l5-1L21 7l-5-5L4 14z" />,
  more: <><circle cx="5" cy="12" r=".8" /><circle cx="12" cy="12" r=".8" /><circle cx="19" cy="12" r=".8" /></>,
} satisfies Record<string, ReactNode>;

export function WorkspaceIcon({ name, size = 20 }: { name: keyof typeof shapes; size?: number }) {
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{shapes[name]}</svg>;
}
