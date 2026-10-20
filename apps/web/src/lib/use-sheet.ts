import { useCallback, useEffect, useState } from "react";

// 시트 열기·닫기 + 브라우저 기록 (아키텍처 9장: 시트를 열 때 기록 한 칸 추가 → 뒤로 가기로 닫힘) (BRD-24)
//   열기: 주소는 그대로 두고 기록만 한 칸 추가 (state에 시트 이름 표시)
//   닫기: 닫기·Esc·바깥 누르기·아래로 끌기 → history.back() → popstate에서 닫힘
//         휴대폰 뒤로 가기도 같은 popstate라 같은 경로로 닫힘
const STATE_KEY = "baradunSheet";

function sheetInHistory(): string | undefined {
  const state: unknown = window.history.state;
  if (state && typeof state === "object" && STATE_KEY in state) {
    return String((state as Record<string, unknown>)[STATE_KEY]);
  }
  return undefined;
}

export function useSheet(id: string) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    // 뒤로 가기로 우리 기록 칸을 벗어나면 닫음
    const onPopState = () => {
      if (sheetInHistory() !== id) setOpen(false);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [open, id]);

  const show = useCallback(() => {
    // Next.js가 pushState를 감싸 자기 정보를 이 칸에 복사(뒤로 가도 페이지를 다시 불러오지 않음)
    window.history.pushState({ [STATE_KEY]: id }, "");
    setOpen(true);
  }, [id]);

  const close = useCallback(() => {
    if (sheetInHistory() === id)
      window.history.back(); // popstate → setOpen(false)
    else setOpen(false); // 기록 칸이 없으면(새로 고침 등) 그냥 닫기
  }, [id]);

  return { open, show, close };
}
