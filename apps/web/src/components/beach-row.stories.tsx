import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { NextIntlClientProvider } from "next-intl";

import en from "../../messages/en.json";
import ko from "../../messages/ko.json";
import type { MetricView } from "@/lib/snapshot/view";
import { BeachRow } from "./beach-row";

// 해변 행 확인용 (BRD-81 · 개발 전용 Storybook). Figma lrow(173:570)·즐겨찾기 행(178:111)·최근 본 행(178:197)
const WAVE: MetricView = {
  kind: "value",
  value: 0.6,
  unit: "m",
  observedAt: "2026-10-21T05:20:00Z",
};

function Rows() {
  return (
    <ul
      style={{ maxWidth: 390, margin: 16, listStyle: "none", padding: 0 }}
      className="overflow-hidden rounded-card bg-bg-surface shadow-card"
    >
      <li>
        <BeachRow
          href="#"
          name="인구해변"
          meta="강원 양양 · 2.1km · 10분 전 측정"
          wave={WAVE}
          detail="파고 0.6m · 주기 6초"
        />
      </li>
      <li className="border-t border-border-default">
        <BeachRow
          href="#"
          name="삼척해수욕장"
          meta="강원 삼척 · 18.4km · 20분 전 측정"
          wave={WAVE}
          detail="풍랑주의보"
        />
      </li>
      <li className="border-t border-border-default">
        <BeachRow
          href="#"
          name="망상해수욕장"
          meta="강원 동해 · 9.8km"
          wave={{ kind: "hidden" }}
          detail={null}
        />
      </li>
      <li className="border-t border-border-default">
        <BeachRow
          href="#"
          name="인구해변"
          meta="강원 양양 · 2.1km · 10분 전 측정"
          wave={WAVE}
          status={{ kind: "clear" }}
          detail="14:20 확인 · 변경 없음"
        />
      </li>
      <li className="border-t border-border-default">
        <BeachRow
          href="#"
          name="경포해변"
          meta="강원 강릉 · 12.0km"
          wave={{ kind: "none" }}
          status={{ kind: "warning", type: "strong_wind", level: "advisory" }}
          detail={null}
          changedFrom="특보 없음"
        />
      </li>
      <li className="border-t border-border-default">
        <BeachRow
          href="#"
          name="송정해수욕장"
          meta="부산 해운대 · 1.2km · 5분 전 측정"
          wave={WAVE}
          detail="파고 0.6m · 주기 6초"
          highlight
        />
      </li>
      <li className="border-t border-border-default">
        <BeachRow
          href="#"
          name="인구해변"
          meta="강원 양양 · 2.1km"
          wave={WAVE}
          status={{ kind: "warning_unknown" }}
          detail={null}
          onRemove={() => {}}
          removeLabel="인구해변 최근 본 기록에서 지우기"
        />
      </li>
    </ul>
  );
}

function RowList({ locale }: { locale: "ko" | "en" }) {
  return (
    <NextIntlClientProvider
      locale={locale}
      messages={locale === "ko" ? ko : en}
      timeZone="Asia/Seoul"
    >
      <Rows />
    </NextIntlClientProvider>
  );
}

const meta = {
  title: "Components/BeachRow",
  component: RowList,
} satisfies Meta<typeof RowList>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Korean: Story = { args: { locale: "ko" } };
export const English: Story = { args: { locale: "en" } };
