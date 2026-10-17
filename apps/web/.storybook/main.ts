import type { StorybookConfig } from "@storybook/nextjs-vite";

// 개발 전용: 컴포넌트 상태확인 및 접근성 점검 (아키텍처 17.4)
const config: StorybookConfig = {
  stories: ["../src/**/*.stories/@(ts|tsx)"],
  addons: ["@storybook/addon-docs", "@storybook/addon-a11y"],
  framework: { name: "@storybook/nextjs-vite", options: {} },
};

export default config;
