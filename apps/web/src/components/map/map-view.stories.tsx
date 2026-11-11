import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { NextIntlClientProvider } from "next-intl";

import en from "../../../messages/en.json";
import ko from "../../../messages/ko.json";
import { KOREA_BOUNDS } from "@/lib/map/bounds";
import { MapView } from "./map-view";

// 지도 틀 확인용 (BRD-65 · 개발 전용 Storybook). 지도 판 파일(map/<판>/)은 같은 출처에만 있어 Storybook에서는 실패 화면이 보임
// 실패 화면은 브라우저 개발자 도구에서 map/ 요청을 막고 '다시 시도'로 확인
function Demo({ locale }: { locale: "ko" | "en" }) {
  return (
    <NextIntlClientProvider
      locale={locale}
      messages={locale === "ko" ? ko : en}
      timeZone="Asia/Seoul"
    >
      <div style={{ height: 560, maxWidth: 760, margin: 16 }}>
        <MapView locale={locale} bounds={KOREA_BOUNDS} className="h-full" />
      </div>
    </NextIntlClientProvider>
  );
}

const meta = {
  title: "Components/MapView",
  component: Demo,
} satisfies Meta<typeof Demo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Korean: Story = { args: { locale: "ko" } };
export const English: Story = { args: { locale: "en" } };
