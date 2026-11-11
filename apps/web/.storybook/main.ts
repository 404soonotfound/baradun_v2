import type { StorybookConfig } from "@storybook/nextjs-vite";

import { devMapOrigin } from "../scripts/dev-map.mjs";

// 개발 전용: 컴포넌트 상태확인 및 접근성 점검 (아키텍처 17.4)
const config: StorybookConfig = {
  stories: ["../src/**/*.stories.@(ts|tsx)"],
  addons: ["@storybook/addon-docs", "@storybook/addon-a11y"],
  framework: { name: "@storybook/nextjs-vite", options: {} },
  // 지도 작업자 파일(public/vendor, npm run map:worker)을 사이트와 같은 주소로 내보냄
  staticDirs: ["../public"],
  // 지도 판 파일 /map/은 운영 CloudFront로 넘겨 같은 출처처럼 받음(scripts/dev-map.mjs, D19-1)
  // storybook dev에서만 넣음. storybook build에는 개발 서버가 없으므로 주소 확인도 하지 않음
  viteFinal(viteConfig, { configType }) {
    if (configType !== "DEVELOPMENT") return viteConfig;
    return {
      ...viteConfig,
      server: {
        ...viteConfig.server,
        proxy: {
          ...viteConfig.server?.proxy,
          "/map/": { target: devMapOrigin(), changeOrigin: true },
        },
      },
    };
  },
};

export default config;
