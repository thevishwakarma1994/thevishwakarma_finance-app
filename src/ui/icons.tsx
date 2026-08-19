type IconProps = {
  size?: number;
};

function svgProps(size: number) {
  return {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none" as const,
    stroke: "currentColor",
    strokeWidth: 1.75,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true as const,
    focusable: false as const,
  };
}

export function HomeIcon({ size = 22 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path d="M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-5v-6H10v6H5a1 1 0 0 1-1-1z" />
    </svg>
  );
}

export function ActivityIcon({ size = 22 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01" />
    </svg>
  );
}

export function PeopleIcon({ size = 22 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <circle cx="9" cy="8" r="3" />
      <path d="M3.5 19a5.5 5.5 0 0 1 11 0" />
      <circle cx="17" cy="9" r="2.5" />
      <path d="M21.5 19a4.5 4.5 0 0 0-6-4.2" />
    </svg>
  );
}

export function MoneyIcon({ size = 22 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <rect x="3" y="6" width="18" height="12" rx="2" />
      <circle cx="12" cy="12" r="2.25" />
      <path d="M3 10h.01M21 14h.01" />
    </svg>
  );
}

export function BackIcon({ size = 22 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path d="M15 5 8 12l7 7" />
    </svg>
  );
}

export function ChevronIcon({ size = 18 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}

export function CloseIcon({ size = 20 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path d="M6 6 18 18M18 6 6 18" />
    </svg>
  );
}

export function CheckIcon({ size = 18 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

export function OverflowIcon({ size = 22 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <circle cx="6" cy="12" r="1.15" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.15" fill="currentColor" stroke="none" />
      <circle cx="18" cy="12" r="1.15" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function AccountIcon({ size = 20 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path d="M4 10.5 12 5l8 5.5V20H4z" />
      <path d="M9 20v-6h6v6" />
    </svg>
  );
}

export function CardIcon({ size = 20 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <rect x="3" y="6" width="18" height="12" rx="2" />
      <path d="M3 10h18" />
    </svg>
  );
}

export function CategoryIcon({ size = 20 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path d="M20 13.5 12.5 21a2 2 0 0 1-2.8 0L3 14.3V4h10.3z" />
      <circle cx="9" cy="9" r="1.2" />
    </svg>
  );
}

export function SalaryIcon({ size = 20 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <rect x="3" y="7" width="18" height="12" rx="2" />
      <path d="M12 11v4M10.5 12.5h3A1.5 1.5 0 0 0 15 11a1.5 1.5 0 0 0-1.5-1.5h-2A1.5 1.5 0 0 0 10 11a1.5 1.5 0 0 0 1.5 1.5Z" />
      <path d="M8 7V5.5A2.5 2.5 0 0 1 10.5 3h3A2.5 2.5 0 0 1 16 5.5V7" />
    </svg>
  );
}

export function BillsIcon({ size = 20 }: IconProps) {
  return (
    <svg {...svgProps(size)}>
      <path d="M7 4h10a2 2 0 0 1 2 2v14l-3-1.5-3 1.5-3-1.5L7 20V6a2 2 0 0 1 2-2z" />
      <path d="M9 9h6M9 13h6" />
    </svg>
  );
}
