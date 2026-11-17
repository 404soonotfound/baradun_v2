import type { Page } from "@playwright/test";

import ko from "../../messages/ko.json";
import { ZONE_NAMES_KO } from "../../src/lib/zone-names-ko";

// '특보 없음' 근거 검사 (리뷰 점검표 5). 가짜 데이터 스위트(states.spec)와 운영 주소 스모크(e2e-live)가 같이 씀
export const FINAL_CALL = ko.safety.finalCall;
// 자정 직후에는 확인 시각이 전날이라 날짜가 붙음(kstStamp: "11/05 23:59")
export const CONFIRMED = /기상청 (?:\d{2}\/\d{2} )?\d{1,2}:\d{2} 확인/;
// 범위: 예보업무규정 별표 구역 이름 1~2개('강원중부앞바다, 강릉평지') 또는 이름을 모를 때의 '해변 특보구역'(D18-11)
const ZONE = `(?:${Object.values(ZONE_NAMES_KO)
  // 정규식 특수 문자를 모두 이스케이프(백슬래시 포함, CodeQL js/incomplete-sanitization)
  .map((name) => name.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&"))
  .join("|")})`;
const SCOPE = `(?:${ZONE}(?:, ${ZONE})?|${ko.warning.beachZones})`;

// PC 홈 전국 지도 카드의 묶음 이름('특보 없음 0곳')은 판단 배지가 아니라 빼고 셈(data-summary-category)
export function notSummaryLabel(page: Page) {
  return page.locator(":not([data-summary-category])");
}

// 화면에 보이는 '특보 없음' 배지
export function clearBadges(page: Page) {
  return page
    .getByText("특보 없음", { exact: true })
    .filter({ visible: true })
    .and(notSummaryLabel(page));
}

// '특보 없음'이 보이는 모든 자리에 범위·기상청·확인 시각과 현장 우선 문구가 붙는지
// 배지에서 바깥으로 올라가며 '기상청 HH:MM 확인'이 든 가장 가까운 묶음을 찾고, 그 묶음이 든 구역에 현장 우선 문구가 있는지 봄
export async function clearPlacesWithoutBasis(page: Page) {
  return page.evaluate(
    ({ finalCall, confirmed, scope }) => {
      const pattern = new RegExp(confirmed);
      const missing: string[] = [];
      const badges = [...document.querySelectorAll("main *")].filter(
        // 글자가 '특보 없음'인 가장 안쪽 요소(아이콘이 든 배지 포함)
        (element) =>
          element.textContent?.trim() === "특보 없음" &&
          !element.hasAttribute("data-summary-category") &&
          ![...element.children].some(
            (child) => child.textContent?.trim() === "특보 없음",
          ) &&
          (element as HTMLElement).offsetParent !== null,
      );
      for (const badge of badges) {
        let box: Element | null = badge;
        let depth = 0;
        while (box && depth < 8 && !pattern.test(box.textContent ?? "")) {
          box = box.parentElement;
          depth += 1;
        }
        const scopeOk =
          box !== null &&
          depth < 8 &&
          new RegExp(`${scope} · ${confirmed}`).test(box.textContent ?? "");
        const section = box?.closest("section, [role='region'], main");
        const finalOk = (section?.textContent ?? "").includes(finalCall);
        if (!scopeOk || !finalOk) {
          missing.push(
            (box ?? badge).textContent?.trim().slice(0, 80) ?? "(빈 자리)",
          );
        }
      }
      return { count: badges.length, missing };
    },
    { finalCall: FINAL_CALL, confirmed: CONFIRMED.source, scope: SCOPE },
  );
}
