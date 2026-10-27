import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

// 테스트에서도 "@/lib/…" 같은 짧은 경로를 쓰게 함 (tsconfig.json의 paths와 같은 뜻)
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
});
