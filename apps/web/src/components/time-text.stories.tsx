import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { NextIntlClientProvider } from "next-intl";

import en from "../../messages/en.json";
import ko from "../../messages/ko.json";
import { useBadgeText } from "@/lib/snapshot/use-badge-text";
import { useTimeText } from "@/lib/snapshot/use-time-text";

const NOW = Date.parse("2026-10-21T05:30:00Z");

// 확인할 경우: 이름, 문구 종류, 넣을 시각
const CASES: {
  name: string;
  kind: "measured" | "issued" | "confirmed";
  at: string | null;
}[] = [
  { name: "측정 10분 전", kind: "measured", at: "2026-10-21T05:20:00Z" },
  { name: "측정 30초 전", kind: "measured", at: "2026-10-21T05:29:30Z" },
  { name: "측정 시각 모름", kind: "measured", at: null },
  { name: "오늘 발표", kind: "issued", at: "2026-10-21T05:05:00Z" },
  { name: "어제 발표", kind: "issued", at: "2026-10-20T05:05:00Z" },
  { name: "오늘 확인", kind: "confirmed", at: "2026-10-21T05:05:00Z" },
  { name: "어제 확인", kind: "confirmed", at: "2026-10-20T14:50:00Z" },
  { name: "확인 시각 모름", kind: "confirmed", at: null },
];

// Provider 안쪽에서 훅 호출
function Rows() {
  const { measuredAgoText, issuedAtText } = useTimeText();
  const { confirmedUntilText } = useBadgeText();
  return (
    <tbody>
      {CASES.map(({ name, kind, at }) => {
        // kind에 따라 문구 함수 하나를 고름. null이면 화면에서는 줄을 그리지 않음
        const text =
          kind === "measured"
            ? measuredAgoText(at, NOW)
            : kind === "issued"
              ? issuedAtText(at, NOW)
              : confirmedUntilText(at, NOW);

        return (
          <tr key={name}>
            <td style={{ padding: 8 }}>{name}</td>
            <td style={{ padding: 8 }}>{text ?? "(그리지 않음)"}</td>
          </tr>
        );
      })}
    </tbody>
  );
}
function TimeTable({ locale }: { locale: "ko" | "en" }) {
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
              문구
            </th>
          </tr>
        </thead>
        <Rows />
      </table>
    </NextIntlClientProvider>
  );
}

const meta = {
  title: "Components/TimeText",
  component: TimeTable,
} satisfies Meta<typeof TimeTable>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Korean: Story = { args: { locale: "ko" } };
export const English: Story = { args: { locale: "en" } };
