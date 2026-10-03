const P = {
  play: 'M7 4.5v15l12-7.5z',
  stop: 'M6 6h12v12H6z',
  pause: 'M7 5h4v14H7zM13 5h4v14h-4z',
  record: 'M12 6a6 6 0 1 0 0 12 6 6 0 0 0 0-12z',
  metronome: 'M10 3h4l4 18H6zm2 4-1 8h2zM12 13l6-7',
  undo: 'M9 7 4 12l5 5M4 12h11a5 5 0 0 1 0 10h-2',
  redo: 'M15 7l5 5-5 5M20 12H9a5 5 0 0 0 0 10h2',
  playlist: 'M3 5h18v3H3zM3 10.5h11v3H3zM3 16h15v3H3z',
  rack: 'M3 4h18v4H3zM3 10h18v4H3zM3 16h18v4H3z',
  piano: 'M3 4h18v16H3zM8 4v9M13 4v9M18 4v9M6 4v9h4V4M11 4v9h4V4',
  mixer: 'M6 3v18M12 3v18M18 3v18M4 15h4M10 8h4M16 12h4',
  sliders: 'M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0M14 4v4M8 10v4M16 16v4',
  plus: 'M12 5v14M5 12h14',
  close: 'M6 6l12 12M18 6 6 18',
  max: 'M5 5h14v14H5z',
  restore: 'M8 8h11v11H8zM5 5h11v3M5 5v11h3',
  folder: 'M3 6h6l2 2h10v11H3z',
  music: 'M9 18V6l11-2v12M9 18a3 3 0 1 1-3-3 3 3 0 0 1 3 3zm11-2a3 3 0 1 1-3-3 3 3 0 0 1 3 3z',
  wave: 'M2 12h3l2-6 3 12 3-9 2 6 2-3h5',
  upload: 'M12 16V4M7 9l5-5 5 5M4 20h16',
  download: 'M12 4v12M7 11l5 5 5-5M4 20h16',
  trash: 'M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13',
  copy: 'M8 8h12v12H8zM4 4h12v2H6v10H4z',
  draw: 'M4 20l4-1 11-11-3-3L5 16zM14 6l3 3',
  select: 'M4 4h4M4 4v4M20 4h-4M20 4v4M4 20h4M4 20v-4M20 20h-4M20 20v-4',
  erase: 'M4 18l8-12 8 6-6 8H8zM10 9l6 5',
  stamp: 'M9 3h6v6l3 4H6l3-4zM5 15h14v3H5zM5 20h14',
  magnet: 'M6 4v8a6 6 0 0 0 12 0V4h-4v8a2 2 0 0 1-4 0V4z',
  slice: 'M12 3v18M7 8l5-5 5 5',
  zoomIn: 'M10 4a6 6 0 1 0 0 12 6 6 0 0 0 0-12zM14.5 14.5 20 20M7 10h6M10 7v6',
  zoomOut: 'M10 4a6 6 0 1 0 0 12 6 6 0 0 0 0-12zM14.5 14.5 20 20M7 10h6',
  claude: 'M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 16.8l-6.2 4.5 2.4-7.4L2 9.4h7.6z',
  midi: 'M4 6h16v12H4zM8 12v6M12 12v6M16 12v6M6 6v6h4V6M14 6v6h4V6',
  menu: 'M4 6h16M4 12h16M4 18h16',
  dots: 'M6 12h.01M12 12h.01M18 12h.01',
  link: 'M10 14l4-4M8 16a4 4 0 0 1 0-6l2-2a4 4 0 0 1 6 0M16 8a4 4 0 0 1 0 6l-2 2a4 4 0 0 1-6 0',
  loop: 'M4 12a7 7 0 0 1 12-5l3 3M20 12a7 7 0 0 1-12 5l-3-3M19 5v5h-5M5 19v-5h5',
  chevronDown: 'M6 9l6 6 6-6',
  chevronRight: 'M9 6l6 6-6 6',
  mute: 'M4 9h4l5-4v14l-5-4H4zM17 9l4 6M21 9l-4 6',
  speaker: 'M4 9h4l5-4v14l-5-4H4zM16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11',
  keyboard: 'M3 6h18v12H3zM6 10h1M9 10h1M12 10h1M15 10h1M18 10h0M7 14h10',
  gear: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
  key: 'M15 7a4 4 0 1 0-3.9 5L4 19v2h3v-2h2v-2h2l1.1-1.1A4 4 0 0 0 15 7zM16 7h.01',
  history: 'M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 3',
  info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 16v-4M12 8h.01',
  check: 'M5 12l5 5 9-10',
  warn: 'M12 3 2 20h20zM12 10v4M12 17h.01',
  spatial: 'M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12v9M12 12 4 7.5',
  plugin: 'M9 3v4M15 3v4M6 7h12v5a6 6 0 0 1-12 0zM12 18v3',
  search: 'M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM15.5 15.5 20 20',
  mic: 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM5 11a7 7 0 0 0 14 0M12 18v3M8 21h8',
  folderPlus: 'M3 6h6l2 2h10v11H3zM12 11v5M9.5 13.5h5',
  scissors: 'M6 4a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM6 15a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM8 8l12 10M8 16 20 6',
  paste: 'M9 3h6v3H9zM7 5H5v16h14V5h-2',
  fadeIn: 'M3 20 21 5v15z',
  fadeOut: 'M3 5l18 15H3z',
  tune: 'M3 17c3 0 3-10 6-10s3 10 6 10 3-6 6-6',
  edit: 'M4 20l4-1 11-11-3-3L5 16zM14 6l3 3'
};

const FILLED = new Set(['play', 'stop', 'pause', 'record', 'claude']);

export function Icon({ name, size = 16, className = '', title }) {
  const filled = FILLED.has(name);
  return (
    <svg className={`icon ${className}`} width={size} height={size} viewBox="0 0 24 24" aria-hidden={title ? undefined : true}
      fill={filled ? 'currentColor' : 'none'} stroke={filled ? 'none' : 'currentColor'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      {title ? <title>{title}</title> : null}
      <path d={P[name] || ''} />
    </svg>
  );
}
