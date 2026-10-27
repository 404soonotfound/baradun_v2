import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { NextIntlClientProvider } from "next-intl";

import en from "../../../messages/en.json";
import ko from "../../../messages/ko.json";
import { BeachRow } from "@/components/beach-row";
import type { MetricView } from "@/lib/snapshot/view";
import { StatusGroup } from "./status-group";

// 상태별 묶음 확인용 (BRD-29 · 개발 전용 Storybook). 노션 3장 StatusGroup
const WAVE: MetricView = {
  kind: "value",
  value: 0.6,
  unit: "m",
  observedAt: "2026-10-27T05:20:00Z",
};

// 스토리에서 넘기는 예시 문구도 언어별로 둠(영어 스토리에 한국어가 섞이지 않게)
const SAMPLE = {
  ko: {
    clearTitle: "특보 없음 2곳",
    clearScope: "특보 없음: 각 해변 특보구역 · 기상청 14:30 확인",
    clearBasis: "이 해변 특보구역 · 기상청 14:30 확인",
    nearest: "가장 가까운 곳 2.1km",
    blockedTitle: "이용불가 1곳",
    unknownTitle: "판단불가 2곳",
    unknownSummary: "특보 확인 못 함 1 · 관측 지연 1",
    delayedValue: "파고 · 측정이 늦어지고 있어요",
    noneValue: "파고 · 가까운 관측 없음",
    final: "최종 판단은 현장 통제와 안전요원 안내가 우선이에요",
    a: "인구해변",
    b: "경포해변",
    c: "송정해수욕장",
    d: "삼척해수욕장",
    meta: "강원 양양 · 2.1km · 10분 전 측정",
    metaShort: "강원 강릉 · 12km",
  },
  en: {
    clearTitle: "No warnings · 2",
    clearScope: "No warnings: each beach's warning zone · KMA · checked 14:30",
    clearBasis: "This beach's warning zone · KMA · checked 14:30",
    nearest: "Nearest 2.1km",
    blockedTitle: "Unavailable · 1",
    unknownTitle: "Cannot determine · 2",
    unknownSummary: "Couldn't check warnings 1 · Observation delayed 1",
    delayedValue: "Wave height · Measurement is delayed",
    noneValue: "Wave height · No nearby observation",
    final: "On-site control and lifeguard guidance come first.",
    a: "Ingu Beach",
    b: "Gyeongpo Beach",
    c: "Songjeong Beach",
    d: "Samcheok Beach",
    meta: "Yangyang, Gangwon · 2.1km · measured 10 min ago",
    metaShort: "Gangneung, Gangwon · 12km",
  },
} as const;

function Groups({ locale }: { locale: "ko" | "en" }) {
  const s = SAMPLE[locale];
  return (
    <NextIntlClientProvider
      locale={locale}
      messages={locale === "ko" ? ko : en}
      timeZone="Asia/Seoul"
    >
      <div
        style={{ maxWidth: 390, margin: 16 }}
        className="flex flex-col gap-5"
      >
        <StatusGroup
          tone="clear"
          title={s.clearTitle}
          aside={s.nearest}
          notes={[s.clearScope, s.final]}
        >
          <li>
            <BeachRow
              href="#"
              name={s.a}
              meta={s.meta}
              wave={WAVE}
              status={{ kind: "clear" }}
              detail={s.clearBasis}
            />
          </li>
          <li>
            <BeachRow
              href="#"
              name={s.b}
              meta={s.metaShort}
              wave={{ kind: "none" }}
              status={{ kind: "clear" }}
              detail={`${s.clearBasis} · ${s.noneValue}`}
            />
          </li>
        </StatusGroup>
        <StatusGroup tone="blocked" title={s.blockedTitle}>
          <li>
            <BeachRow
              href="#"
              name={s.c}
              meta={s.meta}
              wave={WAVE}
              status={{
                kind: "warning",
                type: "wind_wave",
                level: "advisory",
              }}
              detail={null}
            />
          </li>
        </StatusGroup>
        <StatusGroup
          tone="unknown"
          title={s.unknownTitle}
          summary={s.unknownSummary}
        >
          <li>
            <BeachRow
              href="#"
              name={s.d}
              meta={s.metaShort}
              wave={{ kind: "delayed" }}
              status={{ kind: "observation_delayed" }}
              detail={s.delayedValue}
            />
          </li>
          <li>
            <BeachRow
              href="#"
              name={s.b}
              meta={s.metaShort}
              wave={{ kind: "hidden" }}
              status={{ kind: "warning_unknown" }}
              detail={null}
            />
          </li>
        </StatusGroup>
      </div>
    </NextIntlClientProvider>
  );
}

const meta = {
  title: "UI/StatusGroup",
  component: Groups,
} satisfies Meta<typeof Groups>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Korean: Story = { args: { locale: "ko" } };
export const English: Story = { args: { locale: "en" } };
