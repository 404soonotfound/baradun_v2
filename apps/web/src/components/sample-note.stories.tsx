import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { NextIntlClientProvider } from "next-intl";

import en from "../../messages/en.json";
import ko from "../../messages/ko.json";
import { SampleNote } from "./sample-note";

// 개발용 예시 데이터 안내 확인용 (BRD-108 · 개발 전용 Storybook)
// 기본(예시 특보·관측값)과 장소 상세의 예시 해변 목록 안내를 한국어·영어로 봄
function Notes({ locale }: { locale: "ko" | "en" }) {
  const messages = locale === "ko" ? ko : en;
  return (
    <NextIntlClientProvider locale={locale} messages={messages}>
      <div className="flex max-w-[390px] flex-col gap-3.5 bg-bg-page p-4">
        <SampleNote />
        <SampleNote>{messages.detail.sample}</SampleNote>
      </div>
    </NextIntlClientProvider>
  );
}

const meta = {
  title: "Components/SampleNote",
  component: Notes,
  args: { locale: "ko" },
} satisfies Meta<typeof Notes>;
export default meta;

type Story = StoryObj<typeof meta>;
export const Korean: Story = {};
export const English: Story = { args: { locale: "en" } };
