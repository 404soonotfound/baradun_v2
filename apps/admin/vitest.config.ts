import { defineConfig } from "vitest/config";

// 빌드 결과 검사 함수(scripts/check-out.mts)를 단위 테스트함
export default defineConfig({
  test: {
    include: ["**/*.test.{ts,mts}"],
    exclude: ["node_modules/**", ".next/**", "out/**"],
  },
});
