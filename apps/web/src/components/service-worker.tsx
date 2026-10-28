"use client";

import { useEffect } from "react";

// 서비스 워커 등록 (아키텍처 9.1 '오프라인', BRD-42). 워커 파일은 빌드 뒤 out/sw.js로 생김(scripts/build-sw.mts)
// - updateViaCache: "none": sw.js를 HTTP 캐시 없이 매번 서버에 확인 → 새 빌드가 나오면 바로 받음
// - 앱으로 돌아올 때도 새 워커가 있는지 확인(홈 화면 추가 앱은 이동 없이 오래 열려 있음)
// - 개발 서버(next dev)에는 sw.js가 없음. 같은 주소에서 전에 등록한 워커가 저장본으로 고친 코드를 가리지 않게 지움
// 화면에 아무것도 그리지 않음. 서버 렌더 중에는 실행되지 않음(useEffect)
export function ServiceWorkerSetup() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const container = navigator.serviceWorker;
    if (process.env.NODE_ENV !== "production") {
      container
        .getRegistrations()
        .then((registrations) =>
          Promise.all(registrations.map((r) => r.unregister())),
        )
        .catch(() => {});
      return;
    }

    let registration: ServiceWorkerRegistration | null = null;
    let active = true;
    container
      .register("/sw.js", { scope: "/", updateViaCache: "none" })
      .then((r) => {
        if (active) registration = r;
      })
      .catch(() => {}); // 등록 실패: 오프라인 저장만 못 함. 바다 정보 조회는 그대로
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        registration?.update().catch(() => {});
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      active = false;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
  return null;
}
