import { useEffect } from "react";

// 뒤 페이지 스크롤 잠금 (Sheet·Onboarding·SystemDialog 공용)
// 대화상자가 겹쳐 열리고 열린 순서와 다르게 닫혀도(예: 시트 위에 점검 화면이 덮였다가 시트가 먼저 닫힘)
// 잠금이 풀리거나 남지 않게, 잠금 수를 세어 첫 잠금 때 원래 값을 기억하고 마지막 해제 때만 되돌림

type Target = { style: { overflow: string } };

export function createScrollLock(target: () => Target) {
  let count = 0;
  let before = "";

  // 잠그고 해제 함수를 돌려줌. 해제는 여러 번 불러도 한 번만 셈
  return function lock(): () => void {
    if (count === 0) {
      const element = target();
      before = element.style.overflow;
      element.style.overflow = "hidden";
    }
    count += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      count -= 1;
      if (count === 0) target().style.overflow = before;
    };
  };
}

// 앱 전체에서 하나(브라우저에서만 부름: 효과 안)
const lockDocument = createScrollLock(() => document.documentElement);

// active인 동안 뒤 페이지 스크롤을 막음
export function useScrollLock(active = true) {
  useEffect(() => {
    if (!active) return;
    return lockDocument();
  }, [active]);
}
