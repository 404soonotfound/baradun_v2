import type { ComponentType, ReactNode } from "react";

// 왼쪽 메뉴 선 아이콘 (GH-450, 시안 4차 V1 aside의 SVG 그대로). 24 격자 · 선 1.8 · 둥근 끝
// 크기는 className(size-4 등)으로 정함. 장식이라 늘 aria-hidden

// aria-hidden은 받기만 하고 늘 숨김(lucide 아이콘과 같은 자리에 쓰려고 둠)
export type NavIcon = ComponentType<{
  className?: string;
  "aria-hidden"?: boolean | "true" | "false";
}>;

function icon(children: ReactNode): NavIcon {
  function Icon({ className }: { className?: string }) {
    return (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
        className={className}
      >
        {children}
      </svg>
    );
  }
  return Icon;
}

export const HomeIcon = icon(
  <>
    <path d="M4 10.5 12 4l8 6.5V20H4z" />
    <path d="M10 20v-5h4v5" />
  </>,
);
export const StatsIcon = icon(<path d="M5 20V11M12 20V5M19 20v-7" />);
export const CollectionIcon = icon(<path d="M3 12h4l3-7 4 14 3-7h4" />);
export const SourcesIcon = icon(
  <>
    <ellipse cx="12" cy="6" rx="7" ry="3" />
    <path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6" />
  </>,
);
export const BeachesIcon = icon(
  <path d="M3 9c2 0 2-2 4.5-2S10 9 12 9s2-2 4.5-2S19 9 21 9M3 15c2 0 2-2 4.5-2S10 15 12 15s2-2 4.5-2S19 15 21 15" />,
);
export const PublishIcon = icon(<path d="M12 16V4M7 9l5-5 5 5M5 20h14" />);
export const NoticesIcon = icon(<path d="M4 10v4h3l7 4V6L7 10z" />);
export const InquiriesIcon = icon(<path d="M4 5h16v11H9l-5 4z" />);
export const PoliciesIcon = icon(
  <>
    <path d="M6 3h9l4 4v14H6z" />
    <path d="M14 3v5h5" />
  </>,
);
export const AuditIcon = icon(
  <>
    <path d="M3 12a9 9 0 1 0 3-6.7" />
    <path d="M3 4v4h4M12 8v4l3 2" />
  </>,
);
export const SearchIcon = icon(
  <>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </>,
);
export const MoreIcon = icon(
  <>
    <circle cx="5" cy="12" r="1" />
    <circle cx="12" cy="12" r="1" />
    <circle cx="19" cy="12" r="1" />
  </>,
);
