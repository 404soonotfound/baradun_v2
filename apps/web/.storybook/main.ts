import type { StorybookConfig } from "@storybook/nextjs-vite";

// 개발 전용: 컴포넌트 상태확인 및 접근성 점검 (아키텍처 17.4)
const config: StorybookConfig = {
  stories: ["../src/**/*.stories.@(ts|tsx)"],
  addons: ["@storybook/addon-docs", "@storybook/addon-a11y"],
  framework: { name: "@storybook/nextjs-vite", options: {} },
  // 지도 작업자 파일(public/vendor, npm run map:worker)을 사이트와 같은 주소로 내보냄
  staticDirs: ["../public"],
};

export default config;
