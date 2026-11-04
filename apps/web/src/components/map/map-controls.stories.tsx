import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { NextIntlClientProvider } from "next-intl";

import en from "../../../messages/en.json";
import ko from "../../../messages/ko.json";
import { ClusterFace } from "./beach-markers";
import { NearbyNotice } from "./nearby-button";

// 지도 위 묶음 버튼·'내 주변 보기' 안내 확인용 (BRD-114 · 개발 전용 Storybook, addon-a11y)
// 지도 없이 부품만 그림. 실제 지도 위 모습은 MapView 스토리·탐색 화면에서 봄
function Demo({ locale }: { locale: "ko" | "en" }) {
  const messages = locale === "ko" ? ko : en;
  return (
    <NextIntlClientProvider
      locale={locale}
      messages={messages}
      timeZone="Asia/Seoul"
    >
      <div
        style={{ display: "grid", gap: 16, padding: 16, maxWidth: 390 }}
        className="bg-bg-subtle"
      >
        <div style={{ display: "flex", gap: 8 }}>
          {[2, 14, 64].map((count) => (
            <ClusterFace
              key={count}
              count={count}
              label={messages.map.cluster.replace("{count}", String(count))}
              onClick={() => {}}
            />
          ))}
        </div>
        <NearbyNotice notice="denied" />
        <NearbyNotice notice="off" />
        <NearbyNotice notice="unavailable" />
        <NearbyNotice notice="outside" />
      </div>
    </NextIntlClientProvider>
  );
}

const meta = {
  title: "Components/MapControls",
  component: Demo,
} satisfies Meta<typeof Demo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Korean: Story = { args: { locale: "ko" } };
export const English: Story = { args: { locale: "en" } };
