import type { Meta, StoryObj } from "@storybook/nextjs-vite";

import { Button } from "./button";

// 버튼 확인용 (BRD-22)
const meta = {
  title: "UI/Button",
  component: Button,
  args: { children: "다시 시도" },
} satisfies Meta<typeof Button>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Primary: Story = { args: { variant: "primary" } };
export const Secondary: Story = { args: { variant: "secondary" } };
export const Ghost: Story = { args: { variant: "ghost" } };
export const Disabled: Story = { args: { disabled: true } };
