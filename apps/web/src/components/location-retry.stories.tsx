import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { NextIntlClientProvider } from "next-intl";

import en from "../../messages/en.json";
import ko from "../../messages/ko.json";
import { LocationOffBanner } from "@/components/home/location-off-banner";
import type { LocationState } from "@/lib/location";

// 위치 거부 '다시 시도' 확인용 (BRD-139 · 개발 전용 Storybook). 배너 안 버튼의 세 상태를 한국어/영어로 그림
// 거부 → '다시 시도' · 답을 기다리는 중 → '위치 확인 중…'(막힘) · 또 거부 → 기기별 설정 경로(이 브라우저 기준)
// 여기서 누르면 앱 전체 위치 저장소의 retry가 불리지만, 저장소가 거부 상태가 아니라 아무것도 하지 않음
const STATES: { name: string; state: LocationState }[] = [
  { name: "거부", state: { status: "denied", coords: null } },
  {
    name: "다시 시도 중",
    state: { status: "denied", coords: null, retry: "pending" },
  },
  {
    name: "또 거부",
    state: { status: "denied", coords: null, retry: "denied" },
  },
];

function Banners({ locale }: { locale: "ko" | "en" }) {
  return (
    <NextIntlClientProvider
      locale={locale}
      messages={locale === "ko" ? ko : en}
      timeZone="Asia/Seoul"
    >
      <div style={{ display: "grid", gap: 16, padding: 16, maxWidth: 390 }}>
        {STATES.map(({ name, state }) => (
          <LocationOffBanner
            key={name}
            locale={locale}
            location={state}
            onClose={() => {}}
          />
        ))}
      </div>
    </NextIntlClientProvider>
  );
}

const meta = {
  title: "Location/Retry",
  component: Banners,
} satisfies Meta<typeof Banners>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Korean: Story = { args: { locale: "ko" } };
export const English: Story = { args: { locale: "en" } };
