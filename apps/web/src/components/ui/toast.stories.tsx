import type { Meta, StoryObj } from "@storybook/nextjs-vite";

import { Button } from "./button";
import { Toast, useToast } from "./toast";

// 토스트 확인용 (BRD-81 · 개발 전용 Storybook). Figma L16 '당겨서 새로고침 → 변경 알림'(188:484)
// 버튼을 누르면 4초 동안 화면 아래(하단 탭 위 96px)에 나타남
function Demo() {
  const { message, show, hold } = useToast();
  return (
    <div style={{ display: "grid", gap: 12, padding: 16, maxWidth: 390 }}>
      <Button onClick={() => show({ text: "링크를 복사했어요" })}>
        링크 복사 토스트
      </Button>
      <Button
        variant="secondary"
        onClick={() =>
          show({ text: "14:42 기준으로 바뀌었어요 · 2곳 상태 변경" })
        }
      >
        변경 알림 토스트
      </Button>
      <Button
        variant="secondary"
        onClick={() =>
          show({
            text: "최근 본 기록에서 지웠어요",
            action: { label: "되돌리기", onClick: () => {} },
          })
        }
      >
        되돌리기 토스트
      </Button>
      <Toast message={message} onHold={hold} />
    </div>
  );
}

const meta = {
  title: "UI/Toast",
  component: Demo,
} satisfies Meta<typeof Demo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

// 누르지 않아도 바로 보이는 모양(캡처·대비 확인용)
export const Visible: Story = {
  render: () => (
    <div style={{ height: 200 }}>
      <Toast message={{ text: "14:42 기준으로 바뀌었어요 · 2곳 상태 변경" }} />
    </div>
  ),
};
