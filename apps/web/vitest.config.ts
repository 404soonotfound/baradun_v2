import { fileURLToPath } from "node:url";

import { configDefaults, defineConfig } from "vitest/config";

// 테스트에서도 "@/lib/…" 같은 짧은 경로를 쓰게 함 (tsconfig.json의 paths와 같은 뜻)
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  // e2e/는 Playwright 스위트(npm run test:e2e)라 Vitest에서 뺌 (BRD-39)
  test: { exclude: [...configDefaults.exclude, "e2e/**"] },
});
