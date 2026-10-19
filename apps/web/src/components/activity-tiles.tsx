"use client";

import { useId } from "react";
import { useTranslations } from "next-intl";

import { ACTIVITIES, setActivity, useActivity } from "@/lib/activity";
import { cn } from "@/lib/cn";

// 활동 타일 (노션 3장 ActivityTiles): 3칸, 타일 72px, 선택 = 브랜드 파랑 채움, 하나만 고름
// 진짜 라디오 버튼을 숨기고 라벨을 타일로 꾸밈 → 화살표 키·화면 읽기 기본 지원
export function ActivityTiles() {
  const activity = useActivity();
  const t = useTranslations("activity");
  const name = useId(); // 한 화면에 타일 묶음이 둘 있어도 서로 엉키지 않게 하는 이름

  return (
    <fieldset>
      <legend className="sr-only">{t("label")}</legend>
      <div className="grid grid-cols-3 gap-2">
        {ACTIVITIES.map((item) => {
          const selected = item === activity;
          return (
            <label
              key={item}
              className={cn(
                "flex h-tile cursor-pointer items-center justify-center rounded-tile border text-title-s",
                "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-brand-default",
                selected
                  ? "border-brand-default bg-brand-default text-brand-on"
                  : "border-border-strong bg-bg-surface text-text-default hover:bg-bg-subtle",
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
