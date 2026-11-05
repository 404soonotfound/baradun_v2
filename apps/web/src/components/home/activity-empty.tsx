"use client";

import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";

import { ActivityIcon } from "@/components/activity-icon";
import { CARD_LAYOUT } from "@/components/home/near-card";
import type { Activity } from "@/lib/activity";
import { cn } from "@/lib/cn";
import { localizedPath, type Locale } from "@/lib/i18n";

// 고른 활동이 확인된 해변이 전국에 한 곳도 없을 때 (11/5 홈 v3 시안 ActR_P_V3SC0 · M_V3SC0)
// 안내(무슨 일 → 영향 → 다음 행동: 활동 정보 확인 방법) + 확인되면 보일 카드 모양 미리보기(aria-hidden, 값 없음)
// 미리보기는 모양만: 값·배지를 지어내지 않음
export function ActivityEmpty({
  locale,
  activity,
}: {
  locale: Locale;
  activity: Activity;
}) {
  const t = useTranslations();
  const name = t(
    activity === "scuba" ? "activity.scubaFull" : `activity.${activity}`,
  );
  const layout = CARD_LAYOUT[activity];

  return (
    <div className="flex flex-col gap-4 rounded-card bg-bg-surface px-4 pt-[18px] pb-4 shadow-card lg:grid lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)] lg:items-center lg:gap-10 lg:px-6 lg:py-6">
      <div className="flex flex-col gap-2">
        <span
          aria-hidden="true"
          className="flex size-10 items-center justify-center rounded-full bg-brand-weak text-brand-default lg:size-11"
        >
          <ActivityIcon activity={activity} />
        </span>
        <p className="text-title-s text-text-default [word-break:keep-all] lg:text-[19px] lg:leading-[1.4] lg:font-bold lg:tracking-[-0.3px]">
          {t("home.activityEmpty.title", { activity: name })}
        </p>
        <p className="text-body-s text-text-body [word-break:keep-all]">
          <span className="lg:hidden">
            {t("home.activityEmpty.body", { activity: name })}
          </span>
          <span className="hidden lg:inline">
            {t("home.activityEmpty.bodyWide", { activity: name })}
          </span>
        </p>
        <Link
          href={localizedPath(locale, "/guide/")}
          className="inline-flex min-h-touch items-center gap-1 self-start text-label font-bold text-brand-default"
        >
          {t("home.activityEmpty.how")}
          <ArrowRight aria-hidden="true" size={14} />
        </Link>
      </div>
      <div aria-hidden="true" className="relative mt-1 lg:mt-0">
        <span className="absolute -top-2.5 left-3 z-10 rounded-full bg-bg-surface px-2 text-[11px] font-bold text-text-muted">
          {t("home.activityEmpty.preview")}
        </span>
        <div className="grid gap-3 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className={cn(
                "flex flex-col gap-3 rounded-[16px] border border-dashed border-border-strong p-4",
                i > 0 && "hidden lg:flex",
              )}
            >
              <span className="h-5 w-16 rounded-full bg-bg-subtle" />
              <span className="flex flex-col gap-1.5">
                <span className="h-3.5 w-24 rounded bg-border-default" />
                <span className="h-2.5 w-14 rounded bg-bg-subtle" />
              </span>
              <span className="grid grid-cols-2 gap-3">
                {layout.big.map((key) => (
                  <span key={key} className="flex flex-col gap-1">
                    <span className="text-[11px] text-text-muted">
                      {t(`observation.metric.${key}`)}
                    </span>
                    <span className="h-5 w-12 rounded bg-border-default" />
                  </span>
                ))}
              </span>
              <span className="flex h-[52px] flex-col justify-between rounded-[10px] bg-bg-subtle px-3 py-2">
                <span className="text-[10.5px] text-text-muted">
                  {t(`home.activityEmpty.picture.${activity}`)}
                </span>
                <span className="h-4 w-full rounded bg-border-default/70" />
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
