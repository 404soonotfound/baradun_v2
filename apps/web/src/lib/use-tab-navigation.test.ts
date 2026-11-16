import { describe, expect, it } from "vitest";

import { createTabTransition, pathnameOf } from "./use-tab-navigation";

describe("createTabTransition", () => {
  it("전환 전에는 커밋된 탭을 기준으로 보고 떠나는 탭 저장을 허용한다", () => {
    const transition = createTabTransition();
    transition.onPathnameChange("/explore/");

    expect(transition.activeTab("explore")).toBe("explore");
    expect(
      transition.shouldSaveOrigin("explore", "/explore/", "/explore/"),
    ).toBe(true);
  });

  it("홈으로 가는 중에는 같은 탭 기준이 홈이 되어 탐색 재클릭을 막지 않는다", () => {
    const transition = createTabTransition();
    transition.onPathnameChange("/explore/");

    transition.start("home", "/explore/");

    // 아직 usePathname()이 "/explore/"에 머물러 있어도 가는 중인 탭("home")이 기준
    expect(transition.activeTab("explore")).toBe("home");
    expect(transition.activeTab("explore")).not.toBe("explore");
  });

  it("전환 중 window.location이 먼저 바뀌어도 떠나는 탭 URL·스크롤을 덮어쓰지 않는다", () => {
    const transition = createTabTransition();
    transition.onPathnameChange("/explore/");

    transition.start("home", "/explore/");

    // pushState로 window.location.pathname은 "/"인데 usePathname()은 아직 "/explore/"인 구간
    expect(transition.shouldSaveOrigin("explore", "/explore/", "/")).toBe(
      false,
    );
    // 아직 pushState 전이라도 다른 탭으로 이동 중인 상태면 첫 클릭 저장값을 유지
    expect(
      transition.shouldSaveOrigin("explore", "/explore/", "/explore/"),
    ).toBe(false);
  });

  it("홈 커밋 뒤 passive effect 전에 탐색을 재클릭하면 중간 홈 효과에서 복원 예약을 비우지 않고 pending을 유지한다", () => {
    const transition = createTabTransition();
    transition.onPathnameChange("/explore/");

    transition.start("home", "/explore/");
    // "/" DOM은 커밋됐지만 "/" passive effect(useEffect)가 아직 돌기 전 재클릭
    expect(transition.shouldSaveOrigin("home", "/", "/")).toBe(false);
    transition.start("explore", "/");

    // TabBar · TopNav 두 인스턴스가 "/" 효과를 모두 실행해도 복원은 건너뛰고 pending을 유지
    expect(transition.onPathnameChange("/")).toBe(false);
    expect(transition.onPathnameChange("/")).toBe(false);
    expect(transition.activeTab("home")).toBe("explore");

    // 목적지("/explore/") 효과가 돌면 pending이 해제되고 복원 예약을 소비할 수 있음
    expect(transition.onPathnameChange("/explore/")).toBe(true);
    expect(transition.activeTab("explore")).toBe("explore");
    expect(
      transition.shouldSaveOrigin("explore", "/explore/", "/explore/"),
    ).toBe(true);
  });

  it("전환이 버려져 제자리에 머문 뒤 다른 경로(/spots/x)로 빠지면 pending이 해제된다", () => {
    const transition = createTabTransition();
    transition.onPathnameChange("/explore/");

    transition.start("home", "/explore/");
    transition.start("explore", "/explore/");

    // 경로 변경 없이 머문 뒤 해변 상세 링크로 이동해 /spots/x 효과가 실행됨
    expect(transition.onPathnameChange("/spots/x")).toBe(true);
    expect(transition.activeTab(null)).toBeNull();
  });

  it("전환 중 탐색으로 되돌아와 경로 변경 없이 머문 뒤에는 새 스크롤·이탈을 다시 저장할 수 있다", () => {
    const transition = createTabTransition();
    transition.onPathnameChange("/explore/");

    transition.start("home", "/explore/");
    // 홈 커밋 전 탐색 재클릭 → 목표가 다시 "explore"가 됨
    transition.start("explore", "/explore/");

    // 아직 pushState가 "/"에 잠깐 걸려 있으면 덮어쓰지 않음
    expect(transition.shouldSaveOrigin("explore", "/explore/", "/")).toBe(
      false,
    );
    // 경로가 "/explore/"로 제자리에 있으면 이후 탐색 스크롤 뒤 다시 떠날 때 저장 허용
    expect(
      transition.shouldSaveOrigin("explore", "/explore/", "/explore/"),
    ).toBe(true);
  });

  it("상세(/spots/…)에서 다른 탭을 누른 뒤 재클릭해도 원래 소속 탭 상태를 덮어쓰지 않는다", () => {
    const transition = createTabTransition();
    transition.onPathnameChange("/spots/gangmun/");

    transition.start("home", "/spots/gangmun/");

    expect(transition.activeTab(null)).toBe("home");
    expect(
      transition.shouldSaveOrigin(null, "/spots/gangmun/", "/spots/gangmun/"),
    ).toBe(false);
    expect(transition.shouldSaveOrigin(null, "/spots/gangmun/", "/")).toBe(
      false,
    );

    transition.start("explore", "/spots/gangmun/");
    expect(transition.activeTab(null)).toBe("explore");

    // 목적지 커밋 뒤에는 상태가 비워짐
    expect(transition.onPathnameChange("/explore/")).toBe(true);
    expect(transition.activeTab("explore")).toBe("explore");
    expect(
      transition.shouldSaveOrigin("explore", "/explore/", "/explore/"),
    ).toBe(true);
  });

  it("뒤로 가기(popstate)로 원래 경로에 머물러 전환이 중단되면 pending과 복원 예약을 정리한다", () => {
    const transition = createTabTransition();
    transition.onPathnameChange("/explore/");

    transition.start("home", "/explore/");

    expect(transition.onPopState("/explore/", "/explore/")).toBe(true);
    expect(transition.activeTab("explore")).toBe("explore");
    expect(transition.onPopState("/explore/", "/explore/")).toBe(false);
  });
});

describe("pathnameOf", () => {
  it("쿼리스트링과 해시를 떼어 커밋된 pathname과 비교할 수 있게 정규화한다", () => {
    expect(pathnameOf("/favorites/?tab=recent")).toBe("/favorites/");
    expect(pathnameOf("/explore/#top")).toBe("/explore/");
    expect(pathnameOf("/")).toBe("/");
  });
});
