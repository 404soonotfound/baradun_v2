"use client";

import { useTranslations } from "next-intl";

import { useActivity } from "@/lib/activity";

// 빈 화면에서 "선택한 활동이 전 화면에서 유지되는지" 확인하는 줄 (BRD-24, 임시)
// 실제 화면(홈·탐색·상세)이 생기면 각 화면이 useActivity()로 직접 사용
export function CurrentActivity() {
  const activity = useActivity();
  const t = useTranslations("activity");
  return (
    <p className="mt-2 text-caption text-text-muted">
      {t("current", { name: t(activity) })}
    </p>
  );
}
