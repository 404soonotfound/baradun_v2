import type { WeatherFile } from "@baradun/contracts";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { NextIntlClientProvider } from "next-intl";

import example from "../../../../../packages/contracts/examples/valid/weather.json";
import en from "../../../messages/en.json";
import ko from "../../../messages/ko.json";
import type { Locale } from "@/lib/i18n";
import { beachWeather, type WeatherView } from "@/lib/snapshot/weather";
import { WeatherCard } from "./weather-card";

// 상세 날씨 카드 확인용 (BRD-185 · 개발 전용 Storybook). 계약 예시 파일 그대로
// 정상(시간 줄 2칸 · 글피 · 중기 2일) · 중기예보만 못 받음 · 전부 못 받음 · 불러오는 중

const FILE = example as unknown as WeatherFile;
const NOW = Date.parse("2026-11-04T23:30:00Z"); // KST 11/5 08:30

type Mode = "ready" | "midFailed" | "failed" | "loading";
function viewOf(mode: Mode): WeatherView {
  if (mode === "loading") return { kind: "loading" };
  if (mode === "failed") return beachWeather(FILE, "b0008"); // 단기예보 없음
  const view = beachWeather(FILE, "b0002");
  return mode === "midFailed" && view.kind === "ready"
    ? { ...view, midLand: null }
    : view;
}

function Card({ locale, mode }: { locale: Locale; mode: Mode }) {
  return (
    <NextIntlClientProvider
      locale={locale}
      messages={locale === "ko" ? ko : en}
      timeZone="Asia/Seoul"
    >
      <div style={{ padding: 16, maxWidth: 420 }} className="bg-bg-page">
        <WeatherCard
          weather={viewOf(mode)}
          region={locale === "ko" ? "강원 강릉시" : "Gangneung, Gangwon"}
          locale={locale}
          nowMs={NOW}
        />
      </div>
    </NextIntlClientProvider>
  );
}

const meta = {
  title: "Detail/WeatherCard",
  component: Card,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof Card>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Korean: Story = { args: { locale: "ko", mode: "ready" } };
export const English: Story = { args: { locale: "en", mode: "ready" } };
export const MidFailed: Story = { args: { locale: "ko", mode: "midFailed" } };
export const Failed: Story = { args: { locale: "ko", mode: "failed" } };
export const Loading: Story = { args: { locale: "ko", mode: "loading" } };
