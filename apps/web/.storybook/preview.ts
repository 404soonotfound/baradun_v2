import type { Preview } from "@storybook/nextjs-vite";
import "../src/app/globals.css";

const preview: Preview = {
  parameters: {
    // 접근성 위반을 오류로 표시
    a11y: { test: "error" },
  },
};

export default preview;
