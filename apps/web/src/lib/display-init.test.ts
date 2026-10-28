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

// 그리기 전 스크립트를 가짜 document·localStorage·matchMedia 위에서 돌려 봄 (BRD-106 결정 35)

class FakeElement {
  attributes = new Map<string, string>();
  parent: FakeHead | null = null;
  constructor(readonly tag: string) {}
  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  removeAttribute(name: string) {
    this.attributes.delete(name);
  }
  get parentNode() {
    return this.parent;
  }
}

class FakeHead {
  children: FakeElement[] = [];
  appendChild(child: FakeElement) {
    child.parent = this;
    this.children.push(child);
  }
  insertBefore(child: FakeElement, before: FakeElement) {
    child.parent = this;
    this.children.splice(this.children.indexOf(before), 0, child);
  }
}

// Next가 viewport로 넣는 기기 설정용 두 줄
function nextThemeMetas(head: FakeHead) {
  for (const [scheme, color] of [
    ["light", THEME_COLORS.light],
    ["dark", THEME_COLORS.dark],
  ]) {
    const meta = new FakeElement("meta");
    meta.setAttribute("name", "theme-color");
    meta.setAttribute("media", `(prefers-color-scheme: ${scheme})`);
    meta.setAttribute("content", color!);
    head.appendChild(meta);
  }
}

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
  const html = new FakeElement("html");
  const head = new FakeHead();
  if (withNextMetas) nextThemeMetas(head);
  const observers: (() => void)[] = [];
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
    createElement: (tag: string) => new FakeElement(tag),
    querySelector: (selector: string) => {
      expect(selector).toBe('meta[name="theme-color"]');
      return (
        head.children.find(
          (child) => child.getAttribute("name") === "theme-color",
        ) ?? null
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
    constructor(private callback: () => void) {}
    observe(target: unknown, options: { attributeFilter: string[] }) {
      expect(target).toBe(html);
      expect(options.attributeFilter).toEqual(["data-theme"]);
      observers.push(this.callback);
    }
  }
  vm.runInNewContext(DISPLAY_INIT_SCRIPT, {
    document,
    localStorage,
    window,
    MutationObserver,
  });

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
    effective,
    setTheme(value: string | null) {
      if (value === null) html.removeAttribute("data-theme");
      else html.setAttribute("data-theme", value);
      observers.forEach((callback) => callback());
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

  it("viewport의 media 두 줄보다 앞에 하나만 넣음", () => {
    const page = run({ stored: { [THEME_STORAGE_KEY]: "dark" } });
    const metas = page.head.children;
    expect(metas).toHaveLength(3);
    expect(metas[0]!.getAttribute("media")).toBeNull();
    expect(metas[0]!.getAttribute("content")).toBe(THEME_COLORS.dark);
    // Next가 넣은 두 줄은 그대로 둠(스크립트가 못 돌 때의 기본값)
    expect(metas[1]!.getAttribute("content")).toBe(THEME_COLORS.light);
    expect(metas[2]!.getAttribute("content")).toBe(THEME_COLORS.dark);
  });

  it("theme-color 줄이 없으면 <head> 끝에 넣음", () => {
    const page = run({ withNextMetas: false, systemDark: true });
    expect(page.head.children).toHaveLength(1);
    expect(page.effective()).toBe(THEME_COLORS.dark);
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

  it("저장소를 못 읽어도 기기 설정 색은 넣음", () => {
    const page = run({ storageThrows: true, systemDark: true });
    expect(page.html.getAttribute("data-theme")).toBeNull();
    expect(page.effective()).toBe(THEME_COLORS.dark);
  });

  it("matchMedia가 없으면 고른 테마만 따르고 그 밖은 밝은 색", () => {
    const chosen = run({
      stored: { [THEME_STORAGE_KEY]: "dark" },
      matchMedia: false,
    });
    expect(chosen.head.children[0]!.getAttribute("content")).toBe(
      THEME_COLORS.dark,
    );
    const system = run({ matchMedia: false });
    expect(system.head.children[0]!.getAttribute("content")).toBe(
      THEME_COLORS.light,
    );
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
