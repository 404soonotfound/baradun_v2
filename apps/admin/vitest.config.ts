import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// 빌드 결과 검사 함수(scripts/check-out.mts)와 화면·도움 함수를 단위 테스트함
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    include: ["**/*.test.{ts,mts}"],
    exclude: ["node_modules/**", ".next/**", "out/**"],
  },
});
