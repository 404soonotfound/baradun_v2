import {
  CircleCheck,
  CircleQuestionMark,
  Clock,
  TriangleAlert,
} from "lucide-react";
import type { ReactNode } from "react";

import { StatusBadge } from "@/components/ui/status-badge";
import { badgeTone, type VerdictTone } from "@/lib/badge-tone";
import { useBadgeText } from "@/lib/snapshot/use-badge-text";
import type { BadgeLabel } from "@/lib/snapshot/view";

// 색 + 아이콘 + 실제 사유 텍스트와 함께 보여줌
// 텍스트 분류는 이름(이용불가 판단불가)이 아니라 실제 사유(예: 퓽량주의보, 관측 지연)

// Record<VerdictTone, ReactNode> = 네 색을 모두 키로 가진 객체. 하나라도 빠지면 타입 오류
const ICON: Record<VerdictTone, ReactNode> = {
  clear: <CircleCheck size={14} />,
  blocked: <TriangleAlert size={14} />,
  unknown: <CircleQuestionMark size={14} />,
  stale: <Clock size={14} />,
};

export function ReasonBadge({
  label,
  size = "md",
}: {
  label: BadgeLabel;
  size?: "md" | "sm";
}) {
  // 사유 -> 문구(키). 한국어/영어는 NextIntlClientProvider가 정함
  const { badgeText } = useBadgeText();
  const tone = badgeTone(label);
  return (
    <StatusBadge tone={tone} size={size} icon={ICON[tone]}>
      {badgeText(label)}
    </StatusBadge>
  );
}
