import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  finishNavigation,
  internalHref,
  pendingNavigation,
  samePath,
  startNavigation,
  subscribeNavigation,
} from "./navigation";

const click = {
  button: 0,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  defaultPrevented: false,
};
const anchor = (attrs: Record<string, string>) => ({
  getAttribute: (name: string) => attrs[name] ?? null,
});

describe("페이지 이동 상태", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    finishNavigation();
  });
  afterEach(() => {
    finishNavigation();
    vi.useRealTimers();
  });

  it("누르면 바로 주소를 기억하고, 진행 막대는 150ms 뒤에 보임", () => {
    const seen: unknown[] = [];
    const stop = subscribeNavigation(() => seen.push(pendingNavigation()));
    startNavigation("/sources/", "/collection/");
    expect(pendingNavigation()).toEqual({ href: "/sources/", visible: false });
    vi.advanceTimersByTime(149);
    expect(pendingNavigation()?.visible).toBe(false);
    vi.advanceTimersByTime(1);
    expect(pendingNavigation()?.visible).toBe(true);
    finishNavigation();
    expect(pendingNavigation()).toBeNull();
    expect(seen).toHaveLength(3);
    stop();
  });

  it("150ms 안에 끝나면 막대를 보이지 않음", () => {
    startNavigation("/sources/", "/");
    vi.advanceTimersByTime(100);
    finishNavigation();
    vi.advanceTimersByTime(100);
    expect(pendingNavigation()).toBeNull();
  });

  it("지금 화면을 다시 누르면 이동으로 보지 않음", () => {
    startNavigation("/collection", "/collection/");
    expect(pendingNavigation()).toBeNull();
  });

  it("이동이 멈춰도 15초 뒤 지움", () => {
    startNavigation("/sources/", "/");
    vi.advanceTimersByTime(15_000);
    expect(pendingNavigation()).toBeNull();
  });

  it("samePath는 끝 / 를 맞춰 비교", () => {
    expect(samePath("/a", "/a/")).toBe(true);
    expect(samePath("/a/", "/b/")).toBe(false);
  });
});

describe("internalHref", () => {
  it("같은 사이트 주소만 이동으로 봄(쿼리·조각은 뗌)", () => {
    expect(internalHref(click, anchor({ href: "/sources/?tab=1" }))).toBe(
      "/sources/",
    );
    expect(internalHref(click, anchor({ href: "https://github.com" }))).toBe(
      null,
    );
    expect(internalHref(click, anchor({ href: "//evil.test/" }))).toBe(null);
    expect(internalHref(click, anchor({ href: "#main" }))).toBe(null);
    expect(internalHref(click, null)).toBe(null);
  });

  it("새 탭·보조 키·다운로드·가운데 단추는 아님", () => {
    expect(internalHref(click, anchor({ href: "/a/", target: "_blank" }))).toBe(
      null,
    );
    expect(
      internalHref({ ...click, metaKey: true }, anchor({ href: "/a/" })),
    ).toBe(null);
    expect(internalHref({ ...click, button: 1 }, anchor({ href: "/a/" }))).toBe(
      null,
    );
    expect(internalHref(click, anchor({ href: "/a.csv", download: "" }))).toBe(
      null,
    );
  });
});
