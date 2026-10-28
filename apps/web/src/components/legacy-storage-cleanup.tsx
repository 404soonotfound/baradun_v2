"use client";

import { useEffect } from "react";

import { clearLegacyStorage } from "@/lib/legacy-storage";

// 앱을 열 때 출시에서 뺀 기능의 기기 저장값을 한 번 지움 (BRD-101, lib/legacy-storage.ts)
// 화면에 아무것도 그리지 않음. 서버 렌더 중에는 실행되지 않음(useEffect)
export function LegacyStorageCleanup() {
  useEffect(() => {
    clearLegacyStorage();
  }, []);
  return null;
}
