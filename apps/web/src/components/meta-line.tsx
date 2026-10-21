import { cn } from "@/lib/cn";

// 메타 정보 한 줄 표시. 글자는 useMetaText가 만든것을 그대로 받음
// text가 null이면 아무것도 그리지않음
export function MetaLine({
  text,
  className,
}: {
  text: string | null;
  className?: string;
}) {
  if (text === null) return null;
  return (
    <p className={cn("text-caption text-text-muted", className)}>{text}</p>
  );
}
