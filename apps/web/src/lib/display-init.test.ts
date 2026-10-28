import vm from "node:vm";

import { describe, expect, it } from "vitest";

import tokens from "../../tokens/tokens.json";
import {
  DISPLAY_INIT_SCRIPT,
  MOTION_STORAGE_KEY,
  THEME_STORAGE_KEY,
} from "./display-init";
import { resolveTheme } from "./theme";
import { THEME_COLORS } from "./viewport";

// 그리기 전 스크립트를 가짜 document·localStorage·matchMedia·MutationObserver 위에서 돌려 봄 (BRD-106 결정 35)

class FakeElement {
  attributes = new Map<string, string>();
  writes = 0; // setAttribute 횟수(같은 값을 다시 써서 관찰이 반복되지 않는지 봄)
  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }
  setAttribute(name: string, value: string) {
    this.writes += 1;
    this.attributes.set(name, value);
  }
  removeAttribute(name: string) {
    this.attributes.delete(name);
  }
}

// Next가 viewport로 넣는 기기 설정용 줄
function themeMeta(scheme: "light" | "dark") {
  const meta = new FakeElement();
  meta.attributes.set("name", "theme-color");
  meta.attributes.set("media", `(prefers-color-scheme: ${scheme})`);
  meta.attributes.set("content", THEME_COLORS[scheme]);
  return meta;
}

type ObserveOptions = {
  attributes?: boolean;
  attributeFilter?: string[];
  childList?: boolean;
  subtree?: boolean;
};

function run({
  stored = {},
  systemDark = false,
  storageThrows = false,
  withNextMetas = true,
  matchMedia = true,
  legacyListener = false,
}: {
  stored?: Record<string, string>;
  systemDark?: boolean;
  storageThrows?: boolean;
  withNextMetas?: boolean;
  matchMedia?: boolean;
  legacyListener?: boolean;
} = {}) {
  const html = new FakeElement();
  const head = {
    children: withNextMetas ? [themeMeta("light"), themeMeta("dark")] : [],
  };
  const observed: { target: unknown; options: ObserveOptions }[] = [];
  let observer: (() => void) | null = null;
  const media = {
    matches: systemDark,
    listeners: [] as (() => void)[],
    ...(legacyListener
      ? { addListener: (fn: () => void) => media.listeners.push(fn) }
      : {
          addEventListener: (_: string, fn: () => void) =>
            media.listeners.push(fn),
        }),
  };
  const document = {
    documentElement: html,
    head,
    querySelectorAll: (selector: string) => {
      expect(selector).toBe('meta[name="theme-color"]');
      return head.children.filter(
        (child) => child.getAttribute("name") === "theme-color",
      );
    },
  };
  const localStorage = {
    getItem: (key: string) => {
      if (storageThrows) throw new Error("SecurityError");
      return stored[key] ?? null;
    },
  };
  const window = {
    matchMedia: matchMedia
      ? (query: string) => {
          expect(query).toBe("(prefers-color-scheme: dark)");
          return media;
        }
      : undefined,
  };
  class MutationObserver {
    constructor(callback: () => void) {
      observer = callback;
    }
    observe(target: unknown, options: ObserveOptions) {
      observed.push({ target, options });
    }
  }
  vm.runInNewContext(DISPLAY_INIT_SCRIPT, {
    document,
    localStorage,
    window,
    MutationObserver,
  });

  // 관찰 대상이 바뀐 것처럼 콜백을 부름(실제 브라우저는 바뀐 기록이 있을 때만 부름)
  const notify = () => observer?.();

  // 브라우저가 고르는 theme-color: media 조건이 맞는 첫 줄의 content
  const effective = () =>
    head.children
      .filter((meta) => meta.getAttribute("name") === "theme-color")
      .find((meta) => {
        const query = meta.getAttribute("media");
        if (!query) return true;
        return query.includes("dark") === media.matches;
      })
      ?.getAttribute("content");

  return {
    html,
    head,
    observed,
    effective,
    notify,
    setTheme(value: string | null) {
      if (value === null) html.removeAttribute("data-theme");
      else html.setAttribute("data-theme", value);
      notify();
    },
    setSystemDark(dark: boolean) {
      media.matches = dark;
      media.listeners.forEach((listener) => listener());
    },
  };
}

describe("그리기 전 화면 설정", () => {
  it("저장된 테마·움직임을 <html>에 붙임", () => {
    const page = run({
      stored: { [THEME_STORAGE_KEY]: "dark", [MOTION_STORAGE_KEY]: "off" },
    });
    expect(page.html.getAttribute("data-theme")).toBe("dark");
    expect(page.html.getAttribute("data-motion")).toBe("reduce");
  });

  it("모르는 저장 값은 붙이지 않음(기기 설정)", () => {
    const page = run({ stored: { [THEME_STORAGE_KEY]: "system" } });
    expect(page.html.getAttribute("data-theme")).toBeNull();
  });
});

describe("theme-color (결정 35)", () => {
  it.each([
    ["밝게를 고르면 기기가 어두워도 밝은 색", "light", true, "light"],
    ["어둡게를 고르면 기기가 밝아도 어두운 색", "dark", false, "dark"],
    ["기기 설정(밝음)", undefined, false, "light"],
    ["기기 설정(어두움)", undefined, true, "dark"],
  ] as const)("%s", (_, theme, systemDark, expected) => {
    const page = run({
      stored: theme ? { [THEME_STORAGE_KEY]: theme } : {},
      systemDark,
    });
    expect(page.effective()).toBe(THEME_COLORS[expected]);
  });

  it("media 두 줄을 모두 같은 색으로 맞추고 줄·media는 그대로 둠", () => {
    const page = run({ stored: { [THEME_STORAGE_KEY]: "dark" } });
    expect(page.head.children).toHaveLength(2);
    expect(
      page.head.children.map((meta) => [
        meta.getAttribute("media"),
        meta.getAttribute("content"),
      ]),
    ).toEqual([
      ["(prefers-color-scheme: light)", THEME_COLORS.dark],
      ["(prefers-color-scheme: dark)", THEME_COLORS.dark],
    ]);
  });

  it("<html> data-theme과 <head>의 줄 추가·값 변경을 관찰함", () => {
    const page = run();
    expect(page.observed).toEqual([
      {
        target: page.html,
        options: { attributes: true, attributeFilter: ["data-theme"] },
      },
      {
        target: page.head,
        options: {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ["name", "content"],
        },
      },
    ]);
  });

  it("설정에서 테마를 바꾸면(data-theme) 바로 따라감", () => {
    const page = run({ systemDark: false });
    expect(page.effective()).toBe(THEME_COLORS.light);
    page.setTheme("dark");
    expect(page.effective()).toBe(THEME_COLORS.dark);
    page.setTheme("light");
    expect(page.effective()).toBe(THEME_COLORS.light);
    // 기기 설정으로 돌아가면 기기 값
    page.setSystemDark(true);
    page.setTheme(null);
    expect(page.effective()).toBe(THEME_COLORS.dark);
  });

  it("화면 이동 때 Next가 줄을 새로 그리거나 값을 되돌려도 고른 테마로 다시 맞춤", () => {
    const page = run({ stored: { [THEME_STORAGE_KEY]: "dark" } });
    // 새 줄로 바꿔 넣음
    page.head.children.splice(0, 2, themeMeta("light"), themeMeta("dark"));
    page.notify();
    expect(page.effective()).toBe(THEME_COLORS.dark);
    // 같은 줄의 값을 되돌림
    page.head.children[0]!.setAttribute("content", THEME_COLORS.light);
    page.notify();
    expect(page.effective()).toBe(THEME_COLORS.dark);
  });

  it("값이 이미 맞으면 다시 쓰지 않음(관찰 → 쓰기 → 관찰이 반복되지 않게)", () => {
    const page = run({ stored: { [THEME_STORAGE_KEY]: "dark" } });
    const writes = () => page.head.children.map((meta) => meta.writes);
    // 라이트 줄만 바뀌고 다크 줄은 원래 값 그대로
    expect(writes()).toEqual([1, 0]);
    page.notify();
    page.notify();
    expect(writes()).toEqual([1, 0]);
  });

  it("스크립트가 돌 때 줄이 없어도 나중에 들어오면 맞춤", () => {
    const page = run({
      withNextMetas: false,
      stored: { [THEME_STORAGE_KEY]: "dark" },
    });
    page.head.children.push(themeMeta("light"), themeMeta("dark"));
    page.notify();
    expect(page.effective()).toBe(THEME_COLORS.dark);
  });

  it("기기 설정을 따를 때만 기기 변경을 따라감", () => {
    const system = run({ systemDark: false });
    system.setSystemDark(true);
    expect(system.effective()).toBe(THEME_COLORS.dark);
    system.setSystemDark(false);
    expect(system.effective()).toBe(THEME_COLORS.light);

    const chosen = run({
      stored: { [THEME_STORAGE_KEY]: "light" },
      systemDark: false,
    });
    chosen.setSystemDark(true);
    expect(chosen.effective()).toBe(THEME_COLORS.light);
  });

  it("옛 브라우저(addListener)에서도 기기 변경을 따라감", () => {
    const page = run({ systemDark: false, legacyListener: true });
    page.setSystemDark(true);
    expect(page.effective()).toBe(THEME_COLORS.dark);
  });

  it("저장소를 못 읽어도 기기 설정 색으로 맞춤", () => {
    const page = run({ storageThrows: true, systemDark: true });
    expect(page.html.getAttribute("data-theme")).toBeNull();
    expect(page.effective()).toBe(THEME_COLORS.dark);
  });

  it("matchMedia가 없으면 고른 테마만 따르고 그 밖은 밝은 색", () => {
    const chosen = run({
      stored: { [THEME_STORAGE_KEY]: "dark" },
      matchMedia: false,
    });
    expect(
      chosen.head.children.map((meta) => meta.getAttribute("content")),
    ).toEqual([THEME_COLORS.dark, THEME_COLORS.dark]);
    const system = run({ matchMedia: false });
    expect(
      system.head.children.map((meta) => meta.getAttribute("content")),
    ).toEqual([THEME_COLORS.light, THEME_COLORS.light]);
  });

  it("모르는 data-theme 값은 화면 테마 규칙(resolveTheme)과 같이 기기 설정을 따름", () => {
    for (const value of ["", "system", "DARK", "sepia"]) {
      for (const systemDark of [false, true]) {
        const page = run({ systemDark });
        page.setTheme(value);
        expect(page.effective()).toBe(
          THEME_COLORS[resolveTheme(value, systemDark)],
        );
      }
    }
  });

  it("theme-color 값은 토큰 bg/page(라이트·다크)", () => {
    expect(THEME_COLORS).toEqual({
      light: tokens.color.bg.page.$value,
      dark: tokens.color.bg.page.$extensions.baradun.dark,
    });
  });
});
