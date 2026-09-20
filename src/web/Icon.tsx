const paths = {
  inbox: 'M4 4h16v16H4z M4 13h5l2 3h2l2-3h5',
  dashboard: 'M4 20V10h4v10 M10 20V4h4v16 M16 20v-7h4v7',
  accounts: 'M9 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6 M3 20v-4a6 6 0 0 1 12 0v4 M17 3a3 3 0 0 1 0 6 M19 12a5 5 0 0 1 2 4v4',
  campaigns: 'M20 12a8 8 0 1 1-8-8 M16 12a4 4 0 1 1-4-4 M12 12l9-9 M16 3h5v5',
  skills: 'M12 5C9 3 5 3 3 4v15c3-1 6-1 9 1 3-2 6-2 9-1V4c-2-1-6-1-9 1v15',
  models: 'M8 8h8v8H8z M8 2v3 M16 2v3 M8 19v3 M16 19v3 M2 8h3 M2 16h3 M19 8h3 M19 16h3 M5 5h14v14H5z',
  sandbox: 'M8 3h8 M9 3v6L4 18a2 2 0 0 0 2 3h12a2 2 0 0 0 2-3l-5-9V3 M7 15h10',
  settings: 'M4 6h9 M17 6h3 M4 12h3 M11 12h9 M4 18h9 M17 18h3 M13 3v6 M7 9v6 M17 15v6',
  pause: 'M8 5v14 M16 5v14',
  play: 'M7 4l13 8-13 8z',
  theme: 'M20 15a9 9 0 0 1-11-11A9 9 0 1 0 20 15z',
  logout: 'M9 4H4v16h5 M9 12h12 M17 8l4 4-4 4',
  message: 'M21 11a9 9 0 0 1-9 9 10 10 0 0 1-4-1l-5 2 1-5a9 9 0 1 1 17-5 M8 10h8 M8 14h5',
  upload: 'M12 16V3 M7 8l5-5 5 5 M4 15v6h16v-6',
} as const;

export type IconName = keyof typeof paths;

export function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}
