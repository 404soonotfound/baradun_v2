import { useTranslations } from "next-intl";

import { cn } from "@/lib/cn";

// 기상청 출처 한 줄 (BRD-113 · 기상법 2026-09-18 시행, 기상청 '기상기후데이터 출처표시 가이드')
// 기상청 자료(특보·부이 관측)와 그것으로 만든 배지·개수·값이 보이는 화면마다 그 화면 안에 글자로 둠
// 링크·버튼만으로는 출처 표시로 보지 않으므로 글자만 씀. 현장 우선 문구보다 뒤(아래)에 둠
// variant: status = 특보·관측을 가공한 해변 상태(가이드 '가공했을 때'), buoy = 부이 관측값 그대로(그래프 캡션), plain = 특보 그대로
export function KmaSourceNote({
  variant,
  className,
}: {
  variant: "status" | "buoy" | "plain";
  className?: string;
}) {
  const t = useTranslations("source");
  const key =
    variant === "status" ? "kmaStatus" : variant === "buoy" ? "kmaBuoy" : "kma";
  return (
    <p className={cn("text-caption text-text-muted", className)}>{t(key)}</p>
  );
}
