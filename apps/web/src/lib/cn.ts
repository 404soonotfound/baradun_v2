import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

import tokens from "../../tokens/tokens.json";

// 토큰 이름을 tailwind-merge에 알려 줌 (BRD-22)
// 안 알려 주면 text-badge(글자 크기)와 text-status-clear-fg(글자 색)를 같은 종류로 보고
// 앞의 것을 지워 버림.
const names = (group: object) =>
  Object.keys(group).filter((key) => !key.startsWith("$"));

const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      spacing: names(tokens.spacing),
      text: names(tokens.text),
      radius: names(tokens.radius),
      shadow: names(tokens.shadow),
      ease: names(tokens.ease),
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
