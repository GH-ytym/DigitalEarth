import type { CSSProperties } from 'react';

const paths = {
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m16 16 5 5" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <ellipse cx="12" cy="12" rx="4" ry="9" />
      <path d="M3 12h18M5 6.5h14M5 17.5h14" />
    </>
  ),
  layers: (
    <>
      <path d="m12 3 10 5-10 5L2 8l10-5Z" />
      <path d="m2 12 10 5 10-5M2 16l10 5 10-5" />
    </>
  ),
  locate: (
    <>
      <circle cx="12" cy="12" r="7" />
      <circle cx="12" cy="12" r="2" />
      <path d="M12 2v3m0 14v3M2 12h3m14 0h3" />
    </>
  ),
  home: (
    <>
      <path d="m3 10 9-7 9 7v10H3V10Z" />
      <path d="M9 20v-7h6v7" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  chevron: <path d="m9 5 7 7-7 7" />,
  arrow: <path d="M5 12h14m-5-5 5 5-5 5" />,
  up: <path d="M12 20V4m-6 6 6-6 6 6" />,
  down: <path d="M12 4v16m-6-6 6 6 6-6" />,
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v6m0-10v.01" />
    </>
  ),
  check: <path d="m5 12 4 4L19 6" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 6v6l4 2" />
    </>
  ),
  mouse: (
    <>
      <rect x="6" y="2" width="12" height="20" rx="6" />
      <path d="M12 2v7" />
    </>
  ),
  pin: (
    <>
      <path d="M19 9c0 5-7 12-7 12S5 14 5 9a7 7 0 1 1 14 0Z" />
      <circle cx="12" cy="9" r="2" />
    </>
  ),
  pen: (
    <>
      <path d="M14 5 19 10M4 20l1.2-5.7L16.9 2.6l4.5 4.5L9.7 18.8 4 20Z" />
      <path d="M5.2 14.3l4.5 4.5M12 20h8" />
    </>
  ),
  ruler: (
    <>
      <path d="M2.8 14.7 14.7 2.8l6.5 6.5L9.3 21.2 2.8 14.7Z" />
      <path d="m7 10.5 2 2m1.4-5.4 2 2m1.4-5.4 2 2" />
    </>
  ),
  polyline: (
    <>
      <path d="m5.4 15.5 5.1-6m3.3 1.2 5 3.9" />
      <circle cx="4" cy="17" r="2" />
      <circle cx="12" cy="8" r="2" />
      <circle cx="20" cy="16" r="2" />
    </>
  ),
  straightLine: (
    <>
      <path d="M5.6 16.8 18.4 7.2" />
      <circle cx="4" cy="18" r="2" />
      <circle cx="20" cy="6" r="2" />
    </>
  ),
  orbit: (
    <>
      <circle cx="12" cy="12" r="4" />
      <ellipse cx="12" cy="12" rx="12" ry="5" transform="rotate(-35 12 12)" />
    </>
  ),
  grid: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M9 3v18m6-18v18M3 9h18M3 15h18" />
    </>
  ),
} as const;

export type IconName = keyof typeof paths;
export function Icon({
  name,
  size = 20,
  style,
}: {
  name: IconName;
  size?: number;
  style?: CSSProperties;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={style}
    >
      {paths[name]}
    </svg>
  );
}
