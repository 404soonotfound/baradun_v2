import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { NextIntlClientProvider } from "next-intl";

import en from "../../messages/en.json";
import ko from "../../messages/ko.json";
import type { BadgeLabel } from "@/lib/snapshot/view";
import { ReasonBadge } from "./reason-badge";

// 사유 배지 확인용 (여섯가지 사유를 실제화면처럼 NextIntlClientProvider로 감싸서 한국어/영어로 그려 봄.)
const LABELS: { name: string; label: BadgeLabel }[] = [
  { name: "특보 없음", label: { kind: "clear" } },
  {
    name: "풍량주의보",
    label: { kind: "warning", type: "wind_wave", level: "advisory" },
  },
  {
    name: "강품경보",
    label: { kind: "warning", type: "strong_wind", level: "warning" },
  },
  {
    name: "지진해일중대경보",
    label: { kind: "warning", type: "tsunami", level: "severe_warning" },
  },
  {
    name: "이용 제한(모르는 사유)",
    label: { kind: "restricted" },
  },
  {
    name: "특보 확인 못 함",
    label: { kind: "warning_unknown" },
  },
  {
    name: "관측 지연",
    label: { kind: "observation_delayed" },
  },
  {
    name: "확인 못 함(모르는 사유)",
    label: { kind: "unconfirmed" },
  },
];

// 헌 언어로 모든 사유를 표로 그림
function BadgeTable({ locale }: { locale: "ko" | "en" }) {
  return (
    <NextIntlClientProvider
      locale={locale}
      messages={locale === "ko" ? ko : en}
      timeZone="Asia/Seoul"
    >
      <table style={{ borderCollapse: "collapse", fontSize: 14 }}>
        <thead>
          <tr>
            <th scope="col" style={{ textAlign: "left", padding: 8 }}>
              경우
            </th>
            <th scope="col" style={{ textAlign: "left", padding: 8 }}>
              md
            </th>
            <th scope="col" style={{ textAlign: "left", padding: 8 }}>
              sm
            </th>
          </tr>
        </thead>
        <tbody>
          {LABELS.map(({ name, label }) => (
            <tr key={name}>
              <td style={{ padding: 8 }}>{name}</td>
              <td style={{ padding: 8 }}>
                <ReasonBadge label={label} />
              </td>
              <td style={{ padding: 8 }}>
                <ReasonBadge label={label} size="sm" />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </NextIntlClientProvider>
  );
}

const meta = {
  title: "Components/ReasonBadge",
  component: BadgeTable,
} satisfies Meta<typeof BadgeTable>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Korean: Story = { args: { locale: "ko" } };
export const English: Story = { args: { locale: "en" } };
