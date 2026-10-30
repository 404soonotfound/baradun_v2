"use client";

import { ChevronDown } from "lucide-react";
import { useTranslations } from "next-intl";

import { ActivityTiles } from "@/components/activity-tiles";
import { Sheet } from "@/components/ui/sheet";
import { useActivity } from "@/lib/activity";
import { cn } from "@/lib/cn";
import { useSheet } from "@/lib/use-sheet";

// 상세 머리의 활동 버튼 "수영 ⌄" → 활동 선택 시트 (노션 1장 이동 규칙)
// 판단 상태는 활동에 따라 바뀌지 않음(특보는 모든 활동에 영향). 고른 활동은 전 화면에 유지
export function ActivityButton({ className }: { className?: string }) {
  const activity = useActivity();
  const t = useTranslations("activity");
  const sheet = useSheet("activity");

  return (
    <>
      <button
        type="button"
        onClick={sheet.show}
        aria-haspopup="dialog"
        // Figma '칩 · 새' 높이 34 · 옆 13 · 글자 13.5 보통 굵기(BRD-129)
        // 누르는 영역은 위아래로 넓혀 44px(BRD-39). ::before는 테두리 안쪽(32px) 기준이라 6px
        className={cn(
          "relative flex h-segment shrink-0 items-center gap-[5px] rounded-full border border-border-strong bg-bg-surface px-[13px] text-[13.5px] font-medium text-text-body before:absolute before:inset-x-0 before:-inset-y-1.5 before:content-['']",
          className,
        )}
      >
        {t(activity)}
        <ChevronDown aria-hidden="true" size={13} strokeWidth={2.4} />
      </button>
      <Sheet open={sheet.open} onClose={sheet.close} title={t("choose")}>
        <ActivityTiles />
      </Sheet>
    </>
  );
}
