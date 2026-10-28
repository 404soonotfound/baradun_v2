import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { useId, useState } from "react";

import { Switch } from "./switch";

// 스위치 확인용 (BRD-36 · 개발 전용 Storybook). 설정 '위치 사용' 줄과 같은 모양
function Demo({ initial }: { initial: boolean }) {
  const [checked, setChecked] = useState(initial);
  const titleId = useId();
  const bodyId = useId();
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: 16,
        maxWidth: 390,
      }}
    >
      <div style={{ flex: 1 }}>
        <p id={titleId}>내 주변 탐색에 위치 사용</p>
        <p id={bodyId}>
          가까운 해변을 찾을 때만 쓰고, 기기 안에서만 써요. 서버로 보내지
          않아요.
        </p>
      </div>
      <Switch
        checked={checked}
        onChange={setChecked}
        labelledBy={titleId}
        describedBy={bodyId}
      />
    </div>
  );
}

const meta = {
  title: "UI/Switch",
  component: Demo,
  args: { initial: true },
} satisfies Meta<typeof Demo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const On: Story = {};
export const Off: Story = { args: { initial: false } };
