"use client";

import { Check } from "lucide-react";
import { useId } from "react";
import { useTranslations } from "next-intl";

import { ActivityIcon } from "@/components/activity-icon";
import { ACTIVITIES, setActivity, useActivity } from "@/lib/activity";
import { cn } from "@/lib/cn";

// 활동 타일 (노션 3장 ActivityTiles, Figma '활동 타일 · 새' 170:114·170:119): 3칸, 타일 72px(PC 76), 선택 = 브랜드 파랑 채움 + 오른쪽 위 체크, 하나만 고름
// 아이콘(21) 위 · 글자(12.5 굵게) 아래, 사이 5px (BRD-129). 보이는 질문 + 설명 한 줄(11/5 홈 v3 시안)
// 진짜 라디오 버튼을 숨기고 라벨을 타일로 꾸밈 → 화살표 키·화면 읽기 기본 지원
export function ActivityTiles() {
  const activity = useActivity();
  const t = useTranslations("activity");
  const name = useId(); // 한 화면에 타일 묶음이 둘 있어도 서로 엉키지 않게 하는 이름
  const hintId = useId();

  return (
    <fieldset aria-describedby={hintId} className="min-w-0">
      <legend className="text-title-m text-text-default">{t("label")}</legend>
      <p
        id={hintId}
        className="mt-1 mb-3 text-caption text-text-muted [word-break:keep-all]"
      >
        {t("hint")}
      </p>
      <div className="grid grid-cols-3 gap-2">
        {ACTIVITIES.map((item) => {
          const selected = item === activity;
          return (
            <label
              key={item}
              className={cn(
                "relative flex h-tile cursor-pointer flex-col items-center justify-center gap-[5px] rounded-tile lg:h-[76px] lg:gap-1 border px-[7px] py-0.5 text-label-s font-bold",
                "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-brand-default",
                selected
                  ? "border-brand-default bg-brand-default text-brand-on"
                  : "border-border-default bg-bg-surface text-text-default hover:bg-bg-subtle",
              )}
            >
              <input
                type="radio"
                name={name}
                value={item}
                checked={selected}
                onChange={() => setActivity(item)}
                className="sr-only"
              />
              {/* 색만으로 고른 타일을 구분하지 않게 체크 표시를 더함 */}
              {selected && (
                <span
                  aria-hidden="true"
                  className="absolute top-1.5 right-1.5 flex size-[18px] items-center justify-center rounded-full bg-brand-on text-brand-default"
                >
                  <Check className="size-3" strokeWidth={3} />
                </span>
              )}
              <ActivityIcon activity={item} />
              {item === "scuba" ? (
                <>
                  {/* 모바일은 "스쿠버", PC는 "스쿠버다이빙" 전체 표기 (노션 3장) */}
                  <span className="lg:hidden">{t("scuba")}</span>
                  <span className="hidden lg:inline">{t("scubaFull")}</span>
                </>
              ) : (
                t(item)
              )}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
