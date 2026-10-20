"use client";

import { ChevronDown } from "lucide-react";
import { useTranslations } from "next-intl";

import { ActivityTiles } from "@/components/activity-tiles";
import { Sheet } from "@/components/ui/sheet";
import { useActivity } from "@/lib/activity";
import { useSheet } from "@/lib/use-sheet";

// 상세 머리의 활동 버튼 "수영 ⌄" → 활동 선택 시트 (노션 1장 이동 규칙)
// 판단 상태는 활동에 따라 바뀌지 않음(특보는 모든 활동에 영향). 고른 활동은 전 화면에 유지
export function ActivityButton() {
  const activity = useActivity();
  const t = useTranslations("activity");
  const sheet = useSheet("activity");

  return (
    <>
      <button
        type="button"
        onClick={sheet.show}
        aria-haspopup="dialog"
        className="flex h-chip shrink-0 items-center gap-1 rounded-full border border-border-strong px-3 text-body"
      >
        {t(activity)}
        <ChevronDown aria-hidden="true" size={16} />
      </button>
      <Sheet open={sheet.open} onClose={sheet.close} title={t("choose")}>
        <ActivityTiles />
      </Sheet>
    </>
  );
}
