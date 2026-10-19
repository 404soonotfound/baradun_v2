import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes, ReactNode } from "react";

import { cn } from "@/lib/cn";

// 상태 배지 (노션 4장, 결정 기록 Rev.2.2)
// 색만으로 구분하지 않아요: 아이콘 + 실제 사유 글자(예: 풍랑주의보, 관측 지연)를 함께 넣어요.
// 아이콘(노션 5장): clear 체크 원 · blocked 금지/경고 삼각 · unknown 물음표 원 · stale 시계 · info 달력/달
// tone은 색만 정해요. 무엇을 보여줄지는 publisher가 게시한 분류를 그대로 따라요(화면에서 다시 계산하지 않음).
//   clear   특보 없음
//   blocked 이용불가 (특보 발효)
//   unknown 판단불가 (특보 확인 못 함)
//   stale   판단불가 (관측 지연)
//   info    비시즌·야간 같은 정보 배지 (판단 상태 아님)
const statusBadgeVariants = cva(
  "inline-flex items-center gap-1 rounded-badge border-[1.5px] px-2 text-badge whitespace-nowrap",
  {
    variants: {
      tone: {
        clear: "border-transparent bg-status-clear-bg text-status-clear-fg",
        blocked:
          "border-transparent bg-status-blocked-bg text-status-blocked-fg",
        unknown:
          "border-dashed border-status-unknown-border bg-status-unknown-bg text-status-unknown-fg",
        stale:
          "border-dashed border-status-stale-border bg-status-stale-bg text-status-stale-fg",
        info: "border-transparent bg-info-bg text-info-fg",
      },
      // 높이 26·22 (노션 3장). 노션 2장의 작은 배지 글자 11.5는 이름 규칙(10/19)에 없어 둘 다 text-badge(12.5)
      size: {
        md: "h-badge",
        sm: "h-badge-sm",
      },
    },
    defaultVariants: {
      // 모르는 값이 들어오면 판단불가 모양으로 보여요(위험 정보를 숨기지 않음).
      tone: "unknown",
      size: "md",
    },
  },
);

export interface StatusBadgeProps
  extends
    HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof statusBadgeVariants> {
  // 상태 아이콘 (예: lucide 아이콘). 장식이라 화면 읽기 프로그램에는 글자만 읽혀요.
  icon?: ReactNode;
}

export function StatusBadge({
  className,
  tone,
  size,
  icon,
  children,
  ...props
}: StatusBadgeProps) {
  return (
    <span
      className={cn(statusBadgeVariants({ tone, size }), className)}
      {...props}
    >
      {icon ? (
        <span aria-hidden="true" className="inline-flex size-3.5 shrink-0">
          {icon}
        </span>
      ) : null}
      {children}
    </span>
  );
}
