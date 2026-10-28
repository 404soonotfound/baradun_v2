import { describe, expect, it } from "vitest";

import { createScrollLock } from "./scroll-lock";

// 스크롤 잠금 수 세기 (BRD-38): 겹친 대화상자가 열린 순서와 다르게 닫혀도 꼬이지 않음

function setup(initial = "") {
  const element = { style: { overflow: initial } };
  return { element, lock: createScrollLock(() => element) };
}

describe("createScrollLock", () => {
  it("잠그면 hidden, 풀면 원래 값", () => {
    const { element, lock } = setup("auto");
    const release = lock();
    expect(element.style.overflow).toBe("hidden");
    release();
    expect(element.style.overflow).toBe("auto");
  });

  it("먼저 연 것이 먼저 닫혀도 남은 대화상자가 있는 동안 잠금 유지, 모두 닫히면 원래 값", () => {
    const { element, lock } = setup();
    const sheet = lock();
    const system = lock();
    sheet(); // 뒤로 가기로 시트가 먼저 닫힘
    expect(element.style.overflow).toBe("hidden");
    system(); // 점검이 끝남
    expect(element.style.overflow).toBe("");
  });

  it("같은 해제를 여러 번 불러도 한 번만 셈", () => {
    const { element, lock } = setup();
    const first = lock();
    const second = lock();
    first();
    first();
    expect(element.style.overflow).toBe("hidden");
    second();
    expect(element.style.overflow).toBe("");
  });

  it("모두 풀린 뒤 다시 잠그면 그때 값을 다시 기억함", () => {
    const { element, lock } = setup();
    lock()();
    element.style.overflow = "scroll";
    const release = lock();
    release();
    expect(element.style.overflow).toBe("scroll");
  });
});
