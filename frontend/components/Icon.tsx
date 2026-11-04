import { CSSProperties } from 'react';

// One small stroke icon set for the whole app. 24 unit grid, drawn with currentColor,
// so an icon takes the colour of the text around it. Add new shapes here, never inline.
const PATHS: Record<string, string> = {
  today: 'M12 3v2M12 19v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M3 12h2M19 12h2M4.6 19.4L6 18M18 6l1.4-1.4M8 12a4 4 0 1 0 8 0a4 4 0 1 0-8 0',
  assistant: 'M12 3l1.8 4.9L18.7 9.7l-4.9 1.8L12 16.4l-1.8-4.9L5.3 9.7l4.9-1.8zM18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z',
  brain: 'M12 4.5v15M12 4.5a3 3 0 0 0-5.5 1.5 3 3 0 0 0-2 5 3 3 0 0 0 1 5 3 3 0 0 0 6.5 3.5M12 4.5a3 3 0 0 1 5.5 1.5 3 3 0 0 1 2 5 3 3 0 0 1-1 5 3 3 0 0 1-6.5 3.5M8.5 9.5c1.1 0 2 .7 2.3 1.7M15.5 9.5c-1.1 0-2 .7-2.3 1.7M8 15.5h1.8M16 15.5h-1.8',
  accounting: 'M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6M9 16h3',
  crm: 'M9 11a3.5 3.5 0 1 0 0-7a3.5 3.5 0 1 0 0 7zM2.5 20c.6-3.4 3.2-5.5 6.5-5.5s5.9 2.1 6.5 5.5M16 4.3a3.5 3.5 0 0 1 0 6.4M18.5 14.8c1.7.8 2.8 2.6 3 5.2',
  inventory: 'M12 3l8 4.5v9L12 21l-8-4.5v-9zM4 7.5l8 4.5 8-4.5M12 12v9M8 5.3l8 4.4',
  hr: 'M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM12 12.5a2.5 2.5 0 1 0 0-5a2.5 2.5 0 1 0 0 5zM7.5 17c.7-1.8 2.4-2.8 4.5-2.8s3.8 1 4.5 2.8',
  scheduler: 'M4 6a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1zM4 10h16M8 3v4M16 3v4M8.5 14.5l2 2 4-4',
  meetings: 'M3 7a1 1 0 0 1 1-1h11a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1zM16 10.5l5-3v9l-5-3',
  chat: 'M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-9l-5 4v-4H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM8 10h8M8 13h5',
  social: 'M4 10v4a1 1 0 0 0 1 1h2l8 4V5L7 9H5a1 1 0 0 0-1 1zM7 15l1.5 5M18.5 9.5a3.5 3.5 0 0 1 0 5',
  analytics: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  integrations: 'M9 7V3M15 7V3M6 7h12v4a6 6 0 0 1-12 0zM12 17v4',
  team: 'M12 12a4 4 0 1 0 0-8a4 4 0 1 0 0 8zM4 21c.8-4 4-6.5 8-6.5s7.2 2.5 8 6.5',
  import: 'M12 3v12M7 10l5 5 5-5M4 17v3h16v-3',
  search: 'M11 18a7 7 0 1 0 0-14a7 7 0 1 0 0 14zM20.5 20.5l-4.6-4.6',
  bell: 'M6 9a6 6 0 0 1 12 0c0 6 2.5 7.5 2.5 7.5h-17S6 15 6 9zM10 20a2 2 0 0 0 4 0',
  sun: 'M12 16a4 4 0 1 0 0-8a4 4 0 1 0 0 8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  moon: 'M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z',
  monitor: 'M3 5a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1zM8 20h8M12 16v4',
  'chevron-right': 'M9 5l7 7-7 7',
  'chevron-left': 'M15 5l-7 7 7 7',
  'chevron-down': 'M5 9l7 7 7-7',
  'chevrons-up-down': 'M8 9l4-4 4 4M8 15l4 4 4-4',
  menu: 'M4 7h16M4 12h16M4 17h16',
  x: 'M6 6l12 12M18 6L6 18',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  plus: 'M12 5v14M5 12h14',
  help: 'M12 21a9 9 0 1 0 0-18a9 9 0 1 0 0 18zM9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6M12 17h.01',
  settings: 'M12 15a3 3 0 1 0 0-6a3 3 0 1 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  logout: 'M15 4h3a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-3M10 17l-5-5 5-5M5 12h11',
  'arrow-right': 'M5 12h14M13 6l6 6-6 6',
  'arrow-up-right': 'M7 17L17 7M8 7h9v9',
  clock: 'M12 21a9 9 0 1 0 0-18a9 9 0 1 0 0 18zM12 7v5l3 2',
  inbox: 'M3 13l2.5-7.5A1 1 0 0 1 6.4 5h11.2a1 1 0 0 1 .9.5L21 13v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1zM3 13h5l1.5 2.5h5L16 13h5',
  invoice: 'M7 3h7l5 5v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM14 3v5h5M9 13h6M9 17h4',
  contact: 'M12 12a4 4 0 1 0 0-8a4 4 0 1 0 0 8zM5 20c.7-3.5 3.5-5.5 7-5.5s6.3 2 7 5.5',
  item: 'M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9zM7.5 8.5h.01',
  money: 'M3 7a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1zM12 14.5a2.5 2.5 0 1 0 0-5a2.5 2.5 0 1 0 0 5zM6 9.5v.01M18 14.5v.01',
  warn: 'M12 4l9 16H3zM12 10v4M12 17h.01',
  bank: 'M3 9l9-5 9 5M5 10v7M9.5 10v7M14.5 10v7M19 10v7M3 20h18',
  leave: 'M5 20c0-9 5-14 15-15-1 10-6 15-15 15zM5 20l7-7',
  deal: 'M3 12l4-4 3 2 4-4 3 3 4-1M3 20h18M7 16v4M12 14v6M17 15v5',
  quote: 'M5 4h14v16H5zM9 9h6M9 13h6M9 17h3',
  lead: 'M12 21a9 9 0 1 0 0-18a9 9 0 1 0 0 18zM12 17a5 5 0 1 0 0-10a5 5 0 1 0 0 10zM12 13a1 1 0 1 0 0-2a1 1 0 1 0 0 2z',
  paid: 'M12 21a9 9 0 1 0 0-18a9 9 0 1 0 0 18zM8 12.5l2.7 2.7L16 9.5',
  sidebar: 'M4 4h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM9 4v16',
  keyboard: 'M3 6h18a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1zM6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10',
  party: 'M4 20l4.5-12L16 15.5zM14 4c.5 1.5 0 3-1.5 3.5M19 9c-1.5-.3-3 .4-3.5 2M17 3.5v.01M20.5 6v.01M20 13.5v.01',
  sparkle: 'M12 4l1.6 5.4L19 11l-5.4 1.6L12 18l-1.6-5.4L5 11l5.4-1.6z',
  star: 'M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8L3.5 9.7l5.9-.9z',
  copy: 'M8 8h11a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1zM4 16V4h12',
  external: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  info: 'M12 21a9 9 0 1 0 0-18a9 9 0 1 0 0 18zM12 11v6M12 7.5h.01',
  error: 'M12 21a9 9 0 1 0 0-18a9 9 0 1 0 0 18zM12 7.5v5.5M12 16.5h.01',
  company: 'M4 21V5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v16M15 9h4a1 1 0 0 1 1 1v11M8 8h3M8 12h3M8 16h3M2 21h20'
};

export type IconName = keyof typeof PATHS | string;

export default function Icon({ name, size = 18, className, style, strokeWidth = 1.75, label }: {
  name: IconName;
  size?: number;
  className?: string;
  style?: CSSProperties;
  strokeWidth?: number;
  // Give a label only when the icon is the only thing saying what something is
  label?: string;
}) {
  return (
    <svg
      className={`icon ${className || ''}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={style}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      <path d={PATHS[name] || PATHS.sparkle} />
    </svg>
  );
}
