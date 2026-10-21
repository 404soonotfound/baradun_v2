import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { Star, Waves } from "lucide-react";
import { useState } from "react";

import { Chip, RemovableChip } from "./chip";

// 칩 확인용 (BRD-81 · 개발 전용 Storybook). Figma '칩 · 새'(170:2928)
const meta = {
  title: "UI/Chip",
  component: Chip,
} satisfies Meta<typeof Chip>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Variants: Story = {
  args: { children: "" },
  render: () => (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, padding: 16 }}>
      <Chip>서핑</Chip>
      <Chip variant="on" aria-pressed icon={<Waves size={15} />}>
        수영
      </Chip>
      <Chip variant="sel" aria-haspopup="listbox">
        강원
      </Chip>
      <Chip icon={<Star size={15} />}>즐겨찾기</Chip>
      <Chip size="lg">강원</Chip>
      <RemovableChip removeLabel="수영 · 강원 빼기" onRemove={() => {}}>
        수영 · 강원
      </RemovableChip>
    </div>
  ),
};

// 눌러서 켜고 끄기(aria-pressed가 같이 바뀌는지 확인)
function ToggleDemo() {
  const [on, setOn] = useState(false);
  return (
    <div style={{ padding: 16 }}>
      <Chip
        variant={on ? "on" : "default"}
        aria-pressed={on}
        onClick={() => setOn(!on)}
      >
        서핑
      </Chip>
    </div>
  );
}

export const Toggle: Story = {
  args: { children: "" },
  render: () => <ToggleDemo />,
};
