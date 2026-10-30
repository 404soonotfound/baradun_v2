import { ChevronRight, X } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

// 알림 배너 (BRD-81 · 컴포넌트 명세 Banner, Figma '알림 배너 · 새' 170:2924·170:107: 모서리 14·제목 13.5, BRD-129)
// 문구는 무슨 일(제목) → 영향·다음 행동(설명) 2줄. 화면당 하나만 둠(어디에 둘지는 화면이 정함)
//   amber: 관측 지연(누르면 상세로) · red: 새 정보 불러오기 실패, 문의 보내지 못함 · gray: 오프라인·위치 권한 꺼짐 등

// 색 묶음 3가지. 테두리·아이콘 원 배경·아이콘 색을 토큰 이름 그대로 연결
const TONES = {
  amber: {
    border: "border-banner-amber-border",
    iconBox: "bg-banner-amber-icon-bg text-banner-amber-icon-fg",
  },
  red: {
    border: "border-banner-red-border",
    iconBox: "bg-banner-red-icon-bg text-banner-red-icon-fg",
  },
  gray: {
    border: "border-banner-gray-border",
    iconBox: "bg-banner-gray-icon-bg text-banner-gray-icon-fg",
  },
} as const;

// keyof typeof TONES = TONES의 키 이름들("amber" | "red" | "gray")을 타입으로 꺼냄
export type BannerTone = keyof typeof TONES;

// action·dismiss와 href는 같이 둘 수 없음(링크 안에 버튼이 들어가지 않게). 같이 주면 타입 오류
type BannerTarget =
  // 2줄째 끝에 붙는 행동(예: '다시 시도' 버튼), 오른쪽 닫기(X) 버튼
  | {
      action?: ReactNode;
      href?: undefined;
      dismiss?: { label: string; onClick: () => void };
    }
  // 배너 전체를 누르는 링크로 만들 때(관측 지연 → 상세). 오른쪽에 › 표시
  | { href: string; action?: undefined; dismiss?: undefined };

export function Banner({
  tone,
  icon,
  title,
  children,
  action,
  href,
  dismiss,
  size = "m",
}: {
  tone: BannerTone;
  icon?: ReactNode; // 없으면 아이콘 원 없이 글자만(홈 '위치 없이 보고 있어요', Figma 171:818)
  title: string; // 1줄째: 무슨 일
  children?: ReactNode; // 2줄째: 영향·다음 행동
  // l: 화면 전체에 영향을 주는 안내(확인된 판단 없음, Figma L13 188:270). 아이콘 원 34·제목 14.5/21·설명 12.5/18.1, 위 정렬
  size?: "m" | "l";
} & BannerTarget) {
  const colors = TONES[tone];
  const large = size === "l";
  const body = (
    <>
      {icon && (
        <span
          aria-hidden="true"
          className={cn(
            "flex shrink-0 items-center justify-center rounded-full",
            large ? "size-[34px]" : "size-8",
            colors.iconBox,
          )}
        >
          {icon}
        </span>
      )}
      <span
        className={cn("min-w-0 flex-1", large && "flex flex-col gap-[3px]")}
      >
        <span
          className={cn(
            "block text-text-default",
            large ? "text-[14.5px]/[21px] font-bold" : "text-label",
          )}
        >
          {title}
        </span>
        {(children || action) && (
          <span
            className={cn(
              "block text-text-muted",
              large ? "text-label-s" : "text-caption",
            )}
          >
            {children}
            {/* 설명과 행동 사이 가운뎃점. 둘 다 있을 때만 */}
            {children && action ? " · " : null}
            {/* 행동은 글줄 안에 두되 누르는 영역은 44px: 위아래 음수 여백으로 줄 높이는 그대로 */}
            {action && (
              <span className="[&>*]:-my-3.5 [&>*]:inline-flex [&>*]:min-h-touch [&>*]:items-center [&>*]:align-middle">
                {action}
              </span>
            )}
          </span>
        )}
      </span>
      {dismiss && (
        <button
          type="button"
          onClick={dismiss.onClick}
          aria-label={dismiss.label}
          className="-my-2.5 -mr-2.5 flex size-touch shrink-0 items-center justify-center rounded-full text-text-muted hover:bg-bg-subtle"
        >
          <X aria-hidden="true" size={16} />
        </button>
      )}
      {href && (
        <ChevronRight
          aria-hidden="true"
          size={16}
          className="shrink-0 text-text-muted"
        />
      )}
    </>
  );
  const box = cn(
    "flex w-full gap-3 rounded-button border bg-bg-surface px-[15px]",
    large ? "items-start py-[15px]" : "items-center py-[13px]",
    colors.border,
  );
  // red(실패)는 바로 읽어 줌(role="alert"), 나머지는 하던 말을 끊지 않음(role="status")
  const role = tone === "red" ? "alert" : "status";
  if (href) {
    return (
      <div role={role}>
        <Link href={href} className={cn(box, "min-h-touch")}>
          {body}
        </Link>
      </div>
    );
  }
  return (
    <div role={role} className={box}>
      {body}
    </div>
  );
}
