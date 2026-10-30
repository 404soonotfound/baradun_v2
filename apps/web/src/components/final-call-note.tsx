import { Shield } from "lucide-react";
import { useTranslations } from "next-intl";

import { cn } from "@/lib/cn";

// 현장 우선 문구 한 줄 (저장소 AGENTS.md 제품 규칙: 판단 카드·주요 행동 가까이)
// Figma P0 'final' 186:318·188:320: 방패 아이콘 14 + 12/17.4 보조 본문 색, 사이 6 (BRD-129)
// 방패는 꾸밈이라 화면 읽기에서 숨김
export function FinalCallNote({ className }: { className?: string }) {
  const t = useTranslations("safety");
  return (
    <p
      className={cn(
        "flex items-start gap-1.5 text-caption text-text-body",
        className,
      )}
    >
      <Shield aria-hidden="true" size={14} className="mt-[1.5px] shrink-0" />
      {t("finalCall")}
    </p>
  );
}
