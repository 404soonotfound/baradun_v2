import type { Meta, StoryObj } from "@storybook/nextjs-vite";

import { BeachRowSkeleton, RisingSkeleton, Skeleton } from "./skeleton";

// 스켈레톤 확인용 (BRD-81 · 개발 전용 Storybook). Figma S_M02_03 '처음 불러오는 중'(173:846)의 목록 부분
const meta = {
  title: "UI/Skeleton",
  component: BeachRowSkeleton,
} satisfies Meta<typeof BeachRowSkeleton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const BeachRows: Story = {
  args: { rows: 4, label: "해변 정보를 불러오고 있어요" },
  render: (args) => (
    <div style={{ padding: 16, maxWidth: 390 }}>
      <BeachRowSkeleton {...args} />
    </div>
  ),
};

export const Blocks: Story = {
  args: { label: "" },
  render: () => (
    <div style={{ display: "grid", gap: 8, padding: 16, maxWidth: 390 }}>
      <Skeleton className="h-5 w-40" />
      <Skeleton className="h-3 w-64" />
      <Skeleton className="h-24 w-full rounded-[18px]" />
    </div>
  ),
};

// 처음 불러올 때 화면 가운데 로더(시안 A). 동작 줄이기를 켜면 멈춘 그림
export const FirstLoad: Story = {
  args: { label: "" },
  render: () => (
    <div
      style={{
        display: "grid",
        placeItems: "center",
        height: 520,
        maxWidth: 390,
      }}
    >
      <RisingSkeleton label="해변 정보를 불러오고 있어요" />
    </div>
  ),
};
