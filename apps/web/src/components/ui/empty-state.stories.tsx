import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { Search, Star } from "lucide-react";

import { Button } from "./button";
import { EmptyState } from "./empty-state";

// 빈 화면 확인용 (BRD-81 · 개발 전용 Storybook). Figma S_M05_03 즐겨찾기 빈 상태(178:287)·S_M02_04 검색 결과 없음
const meta = {
  title: "UI/EmptyState",
  component: EmptyState,
} satisfies Meta<typeof EmptyState>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Favorites: Story = {
  args: {
    icon: <Star size={26} />,
    title: "아직 즐겨찾기한 바다가 없어요",
    description: "해변 상세에서 별을 누르면 여기 모여요",
    action: <Button className="h-[46px]">바다 둘러보기</Button>,
  },
};

export const NoResult: Story = {
  args: {
    icon: <Search size={26} />,
    title: "'송정'에 맞는 해변이 없어요",
    description: "지역 이름이나 해변 이름 일부로 다시 찾아보세요",
  },
};
