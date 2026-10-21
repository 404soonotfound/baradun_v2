import type { Meta, StoryObj } from "@storybook/nextjs-vite";

import { SearchField } from "./search-field";

// 검색창 확인용 (BRD-81 · 개발 전용 Storybook). Figma S_M02_01 탐색 검색창 · L08 검색 화면(186:502)
// 칸을 누르면 테두리가 파란 2px로 바뀌는지 확인
const meta = {
  title: "UI/SearchField",
  component: SearchField,
} satisfies Meta<typeof SearchField>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { label: "해변·지역 검색", placeholder: "해변·지역 검색" },
  render: (args) => (
    <div style={{ padding: 16, maxWidth: 390 }}>
      <SearchField {...args} />
    </div>
  ),
};

export const WithValue: Story = {
  args: {
    label: "해변·지역 검색",
    placeholder: "해변·지역 검색",
    defaultValue: "송정",
  },
  render: (args) => (
    <div style={{ padding: 16, maxWidth: 390 }}>
      <SearchField {...args} />
    </div>
  ),
};
