import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import {
  CircleCheck,
  CircleQuestionMark,
  Clock,
  Moon,
  TriangleAlert,
} from "lucide-react";

import ko from "../../../messages/ko.json";
import { StatusBadge } from "./status-badge";

// 상태 배지 확인용 (BRD-22). 아이콘은 노션 5장: 체크 원 · 경고 삼각 · 물음표 원 · 시계 · 달
// "풍랑주의보"는 데이터에서 오는 실제 사유 예시임.
const meta = {
  title: "UI/StatusBadge",
  component: StatusBadge,
} satisfies Meta<typeof StatusBadge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const AllTones: Story = {
  render: () => (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, padding: 16 }}>
      <StatusBadge tone="clear" icon={<CircleCheck size={14} />}>
        {ko.verdict.clear.title}
      </StatusBadge>
      <StatusBadge tone="blocked" icon={<TriangleAlert size={14} />}>
        풍랑주의보
      </StatusBadge>
      <StatusBadge tone="unknown" icon={<CircleQuestionMark size={14} />}>
        {ko.verdict.unknownWarning.title}
      </StatusBadge>
      <StatusBadge tone="stale" icon={<Clock size={14} />}>
        {ko.verdict.stale.title}
      </StatusBadge>
      <StatusBadge tone="info" size="sm" icon={<Moon size={14} />}>
        야간
      </StatusBadge>
    </div>
  ),
};
