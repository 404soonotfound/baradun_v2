import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { useState } from "react";

import { ViewToggle } from "./view-toggle";

// 세그먼트 확인용 (BRD-81 · 개발 전용 Storybook). Figma '목록·지도 전환 · 새'(170:2929)
function Demo() {
  const [sort, setSort] = useState<"status" | "near">("status");
  const [tab, setTab] = useState<"favorites" | "recent">("favorites");
  return (
    <div style={{ display: "grid", gap: 16, padding: 16, maxWidth: 390 }}>
      <ViewToggle
        label="목록 정렬"
        className="w-[176px]"
        options={[
          { value: "status", label: "상태별" },
          { value: "near", label: "가까운 순" },
        ]}
        value={sort}
        onChange={setSort}
      />
      <ViewToggle
        label="즐겨찾기 보기"
        options={[
          { value: "favorites", label: "즐겨찾기" },
          { value: "recent", label: "최근 본" },
        ]}
        value={tab}
        onChange={setTab}
      />
    </div>
  );
}

const meta = {
  title: "UI/ViewToggle",
  component: Demo,
} satisfies Meta<typeof Demo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};
