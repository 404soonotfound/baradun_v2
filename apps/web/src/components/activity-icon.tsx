import type { ACTIVITIES } from "@/lib/activity";

type TileActivity = (typeof ACTIVITIES)[number];

// 활동 아이콘 (노션 4장 5절 '활동: 수영 · 서핑 · 스쿠버', Figma 아이콘/swim·surf·scuba 8:11, BRD-129)
// lucide에 같은 모양이 없어 Figma 원본 경로를 그대로 옮김. 색은 글자색(currentColor)을 따라 선택·다크에서 바뀜
// 21 격자, 선 두께 1.575(24 격자 1.8과 같은 비율)
const PATHS: Record<TileActivity, readonly string[]> = {
  swimming: [
    "M2.625 13.125C4.375 13.125 4.375 11.8125 6.5625 11.8125C8.75 11.8125 8.3125 13.125 10.5 13.125C12.6875 13.125 12.25 11.8125 14.4375 11.8125C16.625 11.8125 16.625 13.125 18.375 13.125M2.625 16.625C4.375 16.625 4.375 15.3125 6.5625 15.3125C8.75 15.3125 8.3125 16.625 10.5 16.625C12.6875 16.625 12.25 15.3125 14.4375 15.3125C16.625 15.3125 16.625 16.625 18.375 16.625",
    "M14.875 6.125C14.875 7.0915 14.0915 7.875 13.125 7.875C12.1585 7.875 11.375 7.0915 11.375 6.125C11.375 5.1585 12.1585 4.375 13.125 4.375C14.0915 4.375 14.875 5.1585 14.875 6.125Z",
    "M5.25 10.5L8.75 7L11.375 8.75",
  ],
  surfing: [
    "M2.625 14C5.25 7 10.5 4.375 15.75 6.125C13.125 7 11.375 9.625 11.375 14",
  ],
  scuba: [
    "M3.5 10.5C6.125 6.125 11.375 5.25 15.75 7.875L18.375 6.125V13.125L15.75 11.375C11.375 14 6.125 13.125 3.5 10.5Z",
  ],
};

export function ActivityIcon({
  activity,
  size = 21,
}: {
  activity: TileActivity;
  size?: number;
}) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 21 21"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.575}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0"
    >
      {PATHS[activity].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
