import type { Preview } from "@storybook/nextjs-vite";
import "../src/app/globals.css";

const preview: Preview = {
  parameters: {
    // 접근성 위반을 오류로 표시 (라이트·다크 모두 대비 확인)
    a11y: { test: "error" },
  },
  // 위쪽 도구 막대에서 테마를 바꿈. 사이트와 같이 <html data-theme>을 씀.
  globalTypes: {
    theme: {
      description: "화면 테마",
      toolbar: {
        title: "테마",
        icon: "mirror",
        items: [
          { value: "system", title: "시스템" },
          { value: "light", title: "라이트" },
          { value: "dark", title: "다크" },
        ],
        dynamicTitle: true,
      },
    },
  },
  initialGlobals: { theme: "light" },
  decorators: [
    (Story, context) => {
      const theme = context.globals.theme as string;
      const root = document.documentElement;
      if (theme === "light" || theme === "dark")
        root.setAttribute("data-theme", theme);
      else root.removeAttribute("data-theme");
      return Story();
    },
  ],
};

export default preview;
