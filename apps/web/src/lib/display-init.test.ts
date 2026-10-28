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

// 그리기 전 스크립트를 가짜 document·localStorage·MutationObserver 위에서 돌려 봄 (BRD-106 결정 35)

class FakeElement {
  attributes = new Map<string, string>();
  writes: string[] = []; // setAttribute한 속성 이름(같은 값을 다시 쓰지 않는지, content를 건드리지 않는지 봄)
  constructor(readonly nodeName: string) {}
  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }
  setAttribute(name: string, value: string) {
    this.writes.push(name);
    this.attributes.set(name, value);
  }
  removeAttribute(name: string) {
    this.attributes.delete(name);
  }
}

// Next가 viewport로 넣는 기기 설정용 줄
function themeMeta(scheme: "light" | "dark") {
  const meta = new FakeElement("META");
  meta.attributes.set("name", "theme-color");
  meta.attributes.set("media", `(prefers-color-scheme: ${scheme})`);
  meta.attributes.set("content", THEME_COLORS[scheme]);
  return meta;
}

type ObserveOptions = {
  attributes?: boolean;
  attributeFilter?: string[];
  childList?: boolean;
};
type FakeRecord = { addedNodes: FakeElement[] };

function run({
  stored = {},
  storageThrows = false,
  withNextMetas = true,
}: {
  stored?: Record<string, string>;
  storageThrows?: boolean;
  withNextMetas?: boolean;
} = {}) {
  const html = new FakeElement("HTML");
  const head = {
    children: withNextMetas ? [themeMeta("light"), themeMeta("dark")] : [],
  };
  const observers: {
    target: unknown;
    options: ObserveOptions;
    callback: (records: FakeRecord[]) => void;
  }[] = [];
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
  class MutationObserver {
    constructor(private callback: (records: FakeRecord[]) => void) {}
    observe(target: unknown, options: ObserveOptions) {
      observers.push({ target, options, callback: this.callback });
    }
  }
  vm.runInNewContext(DISPLAY_INIT_SCRIPT, {
    document,
    localStorage,
    MutationObserver,
  });

  const observerOf = (target: unknown) =>
    observers.find((observer) => observer.target === target)!;

  // 브라우저가 고르는 theme-color: media 조건이 맞는 첫 줄의 content(HTML 표준 순서)
  const effective = (systemDark: boolean) =>
    head.children
      .filter((meta) => meta.getAttribute("name") === "theme-color")
      .find((meta) => {
        const media = meta.getAttribute("media");
        if (media === null || media === "all") return true;
        if (media === "not all") return false;
        return media.includes("dark") === systemDark;
      })
      ?.getAttribute("content");

  return {
    html,
    head,
    observers,
    effective,
    medias: () => head.children.map((meta) => meta.getAttribute("media")),
    setTheme(value: string | null) {
      if (value === null) html.removeAttribute("data-theme");
      else html.setAttribute("data-theme", value);
      observerOf(html).callback([]);
    },
    // 화면 이동 때 Next가 줄을 새로 넣은 것처럼
    addToHead(...nodes: FakeElement[]) {
      head.children.push(...nodes);
      observerOf(head).callback([{ addedNodes: nodes }]);
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
    const page = run({ stored: theme ? { [THEME_STORAGE_KEY]: theme } : {} });
    expect(page.effective(systemDark)).toBe(THEME_COLORS[expected]);
  });

  it("고른 테마 줄만 media=all, 다른 줄은 not all. content(React가 줄을 찾는 값)는 그대로", () => {
    const page = run({ stored: { [THEME_STORAGE_KEY]: "dark" } });
    expect(
      page.head.children.map((meta) => [
        meta.getAttribute("media"),
        meta.getAttribute("content"),
      ]),
    ).toEqual([
      ["not all", THEME_COLORS.light],
      ["all", THEME_COLORS.dark],
    ]);
    for (const meta of page.head.children) {
      expect(meta.writes).not.toContain("content");
    }
  });

  it("기기 설정이면 원래 media를 그대로 둠(기기 변경은 브라우저가 따라감)", () => {
    const page = run();
    expect(page.medias()).toEqual([
      "(prefers-color-scheme: light)",
      "(prefers-color-scheme: dark)",
    ]);
    // 이미 맞으니 쓰지 않음
    expect(page.head.children.map((meta) => meta.writes)).toEqual([[], []]);
    expect(page.effective(false)).toBe(THEME_COLORS.light);
    expect(page.effective(true)).toBe(THEME_COLORS.dark);
  });

  it("<html> data-theme과 <head>에 새로 들어오는 줄만 관찰함", () => {
    const page = run();
    expect(
      page.observers.map(({ target, options }) => [target, options]),
    ).toEqual([
      [page.html, { attributes: true, attributeFilter: ["data-theme"] }],
      [page.head, { childList: true }],
    ]);
  });

  it("설정에서 테마를 바꾸면(data-theme) 바로 따라가고, 기기 설정으로 돌아가면 원래 media", () => {
    const page = run();
    page.setTheme("dark");
    expect(page.effective(false)).toBe(THEME_COLORS.dark);
    page.setTheme("light");
    expect(page.effective(true)).toBe(THEME_COLORS.light);
    page.setTheme(null);
    expect(page.medias()).toEqual([
      "(prefers-color-scheme: light)",
      "(prefers-color-scheme: dark)",
    ]);
    expect(page.effective(true)).toBe(THEME_COLORS.dark);
  });

  it("고른 테마는 기기 설정이 바뀌어도 그대로", () => {
    const page = run({ stored: { [THEME_STORAGE_KEY]: "light" } });
    expect(page.effective(false)).toBe(THEME_COLORS.light);
    expect(page.effective(true)).toBe(THEME_COLORS.light);
  });

  it("화면 이동 때 Next가 원래 media로 줄을 새로 넣어도 고른 테마로 맞춤", () => {
    const page = run({ stored: { [THEME_STORAGE_KEY]: "dark" } });
    page.head.children.splice(0, 2);
    page.addToHead(themeMeta("light"), themeMeta("dark"));
    expect(page.medias()).toEqual(["not all", "all"]);
    expect(page.effective(false)).toBe(THEME_COLORS.dark);
  });

  it("스크립트가 돌 때 줄이 없어도 나중에 들어오면 맞춤", () => {
    const page = run({
      withNextMetas: false,
      stored: { [THEME_STORAGE_KEY]: "dark" },
    });
    page.addToHead(themeMeta("light"), themeMeta("dark"));
    expect(page.effective(false)).toBe(THEME_COLORS.dark);
  });

  it("theme-color가 아닌 줄·토큰 색이 아닌 줄은 건드리지 않음", () => {
    const page = run({ stored: { [THEME_STORAGE_KEY]: "dark" } });
    const other = new FakeElement("META");
    other.attributes.set("name", "description");
    other.attributes.set("content", THEME_COLORS.light);
    const unknown = new FakeElement("META");
    unknown.attributes.set("name", "theme-color");
    unknown.attributes.set("content", "#123456");
    const link = new FakeElement("LINK");
    page.addToHead(other, unknown, link);
    page.setTheme("light");
    expect([other.writes, unknown.writes, link.writes]).toEqual([[], [], []]);
  });

  it("같은 값이면 다시 쓰지 않음", () => {
    const page = run({ stored: { [THEME_STORAGE_KEY]: "dark" } });
    const writes = () => page.head.children.map((meta) => meta.writes.length);
    expect(writes()).toEqual([1, 1]);
    page.setTheme("dark");
    expect(writes()).toEqual([1, 1]);
  });

  it("저장소를 못 읽어도 원래 media(기기 설정)가 남음", () => {
    const page = run({ storageThrows: true });
    expect(page.html.getAttribute("data-theme")).toBeNull();
    expect(page.effective(true)).toBe(THEME_COLORS.dark);
    expect(page.effective(false)).toBe(THEME_COLORS.light);
  });

  it("모르는 data-theme 값은 화면 테마 규칙(resolveTheme)과 같이 기기 설정을 따름", () => {
    for (const value of ["", "system", "DARK", "sepia"]) {
      for (const systemDark of [false, true]) {
        const page = run();
        page.setTheme(value);
        expect(page.effective(systemDark)).toBe(
          THEME_COLORS[resolveTheme(value, systemDark)],
        );
      }
    }
  });

  it("theme-color 값은 토큰 bg/page(라이트·다크)이고 서로 다름(줄을 색으로 알아봄)", () => {
    expect(THEME_COLORS).toEqual({
      light: tokens.color.bg.page.$value,
      dark: tokens.color.bg.page.$extensions.baradun.dark,
    });
    expect(THEME_COLORS.light).not.toBe(THEME_COLORS.dark);
  });
});
