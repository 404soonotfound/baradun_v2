"use client";

import { useTheme } from "@/lib/theme";

// 모든 페이지에서 다른 탭의 테마 변경(storage 이벤트)을 따라가도록 구독함
export function ThemeSync() {
  useTheme();
  return null;
}
