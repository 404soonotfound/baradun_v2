"use client";

import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";

import { CARD_LAYOUT } from "@/components/home/near-card";
import type { Activity } from "@/lib/activity";
import { cn } from "@/lib/cn";
import { localizedPath, type Locale } from "@/lib/i18n";

// 고른 활동이 확인된 해변이 없을 때 (노션 D18-6, 11/5 홈 v3 시안 ActR_P_V3SC0 · M_V3SC0)
// 전국에 0곳(지금 스쿠버다이빙): 안내 두 줄 + '활동 정보는 어떻게 확인하나요?' + '대신 찾아보기' + 확인되면 보일 카드 미리보기
// 고른 지역에만 없음: 안내 한 줄 + '대신 찾아보기'(같은 활동이 전국에 있으면 '전국 ○○ 해변'이 먼저)
// 미리보기는 모양만(aria-hidden): 값·배지를 지어내지 않음. 대신 찾아보기는 활동·범위만 바꾸고 판단은 바꾸지 않음

// 대신 찾아보기 한 줄(부르는 쪽이 글과 동작을 정함)
export type ActivityAlternative = {
  key: string;
  label: string;
  onSelect: () => void;
};

export function ActivityEmpty({
  locale,
  activity,
  place,
  nationwideZero,
  alternatives,
}: {
  locale: Locale;
  activity: Activity;
  place: string | null; // 고른 지역 이름(지역에만 없을 때 문구)
  nationwideZero: boolean; // 전국에 한 곳도 없음
  alternatives: readonly ActivityAlternative[];
}) {
  const t = useTranslations();
  const name = t(
    activity === "scuba" ? "activity.scubaFull" : `activity.${activity}`,
  );
  const layout = CARD_LAYOUT[activity];
  const altList = alternatives.length > 0 && (
    <div className="flex flex-col gap-2">
      <p className="text-label font-bold text-text-default">
        {t("home.activityEmpty.alternatives")}
      </p>
      <ul className="flex flex-col gap-2">
        {alternatives.map((alt) => (
          <li key={alt.key}>
            <button
              type="button"
              onClick={alt.onSelect}
              className="flex min-h-touch w-full items-center justify-between gap-2 rounded-tile border border-border-default px-3 py-2 text-left text-label-s font-bold text-text-default hover:bg-bg-subtle"
            >
              {alt.label}
              <ArrowRight aria-hidden="true" size={14} className="shrink-0" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );

  if (!nationwideZero) {
    return (
      <div className="flex flex-col gap-3 rounded-card bg-bg-surface p-4 shadow-card lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,320px)] lg:items-start lg:gap-10 lg:rounded-none lg:bg-transparent lg:p-0 lg:shadow-none">
        <p className="text-body-s text-text-body [word-break:keep-all]">
          {t("home.activityEmpty.titleScoped", {
            place: place ?? t("home.nationwide.label"),
            activity: name,
          })}
        </p>
        {altList}
      </div>
    );
  }

  return (
    // PC는 해변 묶음 패널 안이라 상자를 겹치지 않음(노션 D18-6: 안쪽 상자·동그란 아이콘·꽉 찬 버튼 없음)
    <div className="flex flex-col gap-4 rounded-card bg-bg-surface px-4 pt-[18px] pb-4 shadow-card lg:grid lg:grid-cols-[minmax(0,340px)_minmax(0,240px)_minmax(0,1fr)] lg:items-center lg:gap-8 lg:rounded-none lg:bg-transparent lg:px-0 lg:py-2 lg:shadow-none">
      <div className="flex flex-col gap-2">
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
      {altList}
      <div aria-hidden="true" className="relative mt-1 lg:mt-0">
        <span className="absolute -top-2.5 left-3 z-10 rounded-full bg-bg-surface px-2 text-[11px] font-bold text-text-muted">
          {t("home.activityEmpty.preview")}
        </span>
        <div className="grid gap-3 lg:grid-cols-2">
          {[0, 1].map((i) => (
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
