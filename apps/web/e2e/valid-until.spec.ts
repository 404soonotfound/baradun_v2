import type { Page } from "@playwright/test";

import ko from "../messages/ko.json";
import { kstStamp } from "../src/lib/snapshot/clock";

import {
  CLEAR_ID,
  expect,
  expectNoA11yViolations,
  slugOf,
  test,
  UNKNOWN_ID,
  WARNING_ID,
} from "./fixtures";

// 정상 스냅샷의 validUntil 경과 재현 (BRD-131 · 노션 결정 기록 B5 · 아키텍처 9.1)
// 화면을 연 채로 validUntil을 넘기면 새 네트워크 응답을 기다리지 않고 바로 다시 계산해:
// - 일반 해변('특보 없음')은 '특보 확인 못 함' + 'HH:MM 확인 · 이후 확인 못 함'으로 내림
// - 발효 특보 해변은 특보 사유를 그대로 두고 'HH:MM 확인 · 이후 확인 못 함'을 붙임
// - 카드·행·개수 카드·목록 어디에도 '특보 없음'이 남지 않음
// - validUntil 1분 전(경계값)에는 아직 '특보 없음'을 유지함

const MIN = 60_000;
const CLEAR_NAME = "강문해수욕장";
const WARNING_NAME = "경포해수욕장";
const REGION_NAME = "강원 강릉시";

const CLEAR_TITLE = ko.verdict.clear.title;
const CLEAR_SENTENCE = ko.verdict.clear.sentence;
const UNKNOWN_TITLE = ko.verdict.unknownWarning.title;
const UNKNOWN_SENTENCE = ko.verdict.unknownWarning.sentence;
const WARNING_TITLE = ko.verdict.warning.title
  .replace("{type}", ko.warning.type.wind_wave)
  .replace("{level}", ko.warning.level.advisory);
const WARNING_SENTENCE = ko.verdict.warning.sentence.replace(
  "{name}",
  WARNING_TITLE,
);
const SEA_TITLE = ko.home.region.seaTitle.replace("{region}", REGION_NAME);
const CLEAR_SUMMARY_ZERO = `${ko.home.hero.category.clear} ${ko.home.hero.count.replace("{count}", "0")}`;

interface SnapshotTimes {
  nowMs: number;
  validUntil: string;
  clearConfirmedAt: string;
  warningConfirmedAt: string;
  warningPublishedAt: string;
  oldestConfirmedAt: string;
}

function confirmedUntil(confirmedAt: string, nowMs: number): string {
  const time = kstStamp(confirmedAt, nowMs);
  if (!time) throw new Error(`시각 계산 실패: ${confirmedAt}`);
  return ko.verdict.confirmedUntil.replace("{time}", time);
}

function clearScopeText(confirmedAt: string, nowMs: number): string {
  const time = kstStamp(confirmedAt, nowMs);
  if (!time) throw new Error(`시각 계산 실패: ${confirmedAt}`);
  return ko.home.near.clearScope.replace("{time}", time);
}

function badgeScopeText(confirmedAt: string, nowMs: number): string {
  const time = kstStamp(confirmedAt, nowMs);
  if (!time) throw new Error(`시각 계산 실패: ${confirmedAt}`);
  return ko.home.near.badgeScope.replace("{time}", time);
}

function countScopeText(confirmedAt: string, nowMs: number): string {
  const time = kstStamp(confirmedAt, nowMs);
  if (!time) throw new Error(`시각 계산 실패: ${confirmedAt}`);
  return ko.home.region.countScope.replace("{time}", time);
}

function issuedText(publishedAt: string, nowMs: number): string {
  const time = kstStamp(publishedAt, nowMs);
  if (!time) throw new Error(`시각 계산 실패: ${publishedAt}`);
  return ko.observation.issuedAt.replace("{time}", time);
}

// 기기에 저장된 정상 스냅샷에서 픽스처 시각을 읽음(하드코딩 없이 계산)
async function readSnapshotTimes(page: Page): Promise<SnapshotTimes> {
  await expect
    .poll(() =>
      page.evaluate(() => localStorage.getItem("baradun:last-snapshot")),
    )
    .not.toBeNull();

  return page.evaluate(
    ({ clearId, warningId, unknownId }) => {
      const raw = localStorage.getItem("baradun:last-snapshot");
      if (!raw) throw new Error("저장된 스냅샷 없음");
      const parsed = JSON.parse(raw) as {
        status: {
          beaches: Record<
            string,
            {
              validUntil: string;
              warning: {
                lastConfirmedAt: string;
                items: { publishedAt: string }[];
              };
            }
          >;
        };
      };
      const clearBeach = parsed.status.beaches[clearId];
      const warningBeach = parsed.status.beaches[warningId];
      const unknownBeach = parsed.status.beaches[unknownId];
      if (!clearBeach || !warningBeach || !unknownBeach) {
        throw new Error("픽스처 해변 상태 없음");
      }
      return {
        nowMs: Date.now(),
        validUntil: clearBeach.validUntil,
        clearConfirmedAt: clearBeach.warning.lastConfirmedAt,
        warningConfirmedAt: warningBeach.warning.lastConfirmedAt,
        warningPublishedAt: warningBeach.warning.items[0]?.publishedAt ?? "",
        oldestConfirmedAt: unknownBeach.warning.lastConfirmedAt,
      };
    },
    { clearId: CLEAR_ID, warningId: WARNING_ID, unknownId: UNKNOWN_ID },
  );
}

// 목표 시각(targetMs)까지 브라우저 시계를 빨리 감고 지금 시각을 돌려줌
async function advanceClockTo(page: Page, targetMs: number): Promise<number> {
  const currentMs = await page.evaluate(() => Date.now());
  const deltaMs = Math.max(0, targetMs - currentMs);
  await page.clock.fastForward(deltaMs);
  return page.evaluate(() => Date.now());
}

function visibleExactText(page: Page, text: string) {
  return page.getByText(text, { exact: true }).filter({ visible: true });
}

// 탐색은 모바일 처음 보기가 지도라 목록 보기로 시작
test.use({ exploreView: "list" });

for (const scheme of ["light", "dark"] as const) {
  test.describe(`validUntil 만료 (${scheme})`, () => {
    test.use({ colorScheme: scheme });

    test("홈: 만료 시 새 응답 없이 일반 해변·개수 카드가 바뀌고 발효 특보는 유지됨", async ({
      page,
      data,
    }, info) => {
      const desktop = info.project.name === "desktop";
      await page.clock.install({ time: Date.now() });
      await page.goto("/");

      const seaRegion = page.getByRole("region", { name: SEA_TITLE });
      const clearCard = seaRegion.getByRole("link", {
        name: new RegExp(CLEAR_NAME),
      });
      await expect(clearCard).toBeVisible();
      await expect(clearCard).toContainText(CLEAR_TITLE);

      const times = await readSnapshotTimes(page);
      await expect(clearCard).toContainText(
        desktop
          ? badgeScopeText(times.clearConfirmedAt, times.nowMs)
          : clearScopeText(times.clearConfirmedAt, times.nowMs),
      );

      if (desktop) {
        const warningCard = seaRegion.getByRole("link", {
          name: new RegExp(WARNING_NAME),
        });
        await expect(warningCard).toBeVisible();
        await expect(warningCard).toContainText(WARNING_TITLE);
        await expect(
          page.getByRole("link", {
            name: new RegExp(`^${ko.home.hero.category.clear} [1-9]`),
          }),
        ).toBeVisible();
      } else {
        const countCard = seaRegion.getByRole("link", {
          name: new RegExp(`^${REGION_NAME} 해변 \\d+곳 지금 상태`),
        });
        await expect(countCard).toBeVisible();
        await expect(countCard).toContainText(CLEAR_TITLE);
        await expect(countCard).toContainText(WARNING_TITLE);
        await expect(countCard).toContainText(
          countScopeText(times.clearConfirmedAt, times.nowMs),
        );
      }

      await expectNoA11yViolations(page);

      // 새 네트워크 응답을 막은 뒤 validUntil 너머로 시계를 옮김
      const statusBefore = data.requests.filter((path) =>
        path.endsWith("/status.json"),
      ).length;
      data.set("loading");
      const expiredMs = await advanceClockTo(
        page,
        Date.parse(times.validUntil) + 1_000,
      );

      // 일반 해변 카드: '특보 확인 못 함' + 'HH:MM 확인 · 이후 확인 못 함'
      await expect(clearCard).toContainText(UNKNOWN_TITLE);
      await expect(clearCard).toContainText(
        confirmedUntil(times.clearConfirmedAt, expiredMs),
      );
      await expect(clearCard).not.toContainText(CLEAR_TITLE);

      // 카드·개수 카드에 '특보 없음'이 남지 않고 발효 특보 사유는 유지됨
      await expect(seaRegion.getByText(CLEAR_TITLE)).toHaveCount(0);

      if (desktop) {
        const warningCard = seaRegion.getByRole("link", {
          name: new RegExp(WARNING_NAME),
        });
        await expect(warningCard).toContainText(WARNING_TITLE);
        await expect(warningCard).toContainText(
          confirmedUntil(times.warningConfirmedAt, expiredMs),
        );
        // PC 상태 요약은 '특보 없음 0곳'만 남고 확인 시각 근거는 사라짐
        const summaryClear = page.getByRole("link", {
          name: CLEAR_SUMMARY_ZERO,
        });
        await expect(summaryClear).toBeVisible();
        await expect(
          page.getByRole("link", {
            name: new RegExp(`^${ko.home.hero.category.clear} [1-9]`),
          }),
        ).toHaveCount(0);
        await expect(
          visibleExactText(
            page,
            confirmedUntil(times.oldestConfirmedAt, expiredMs),
          ),
        ).toBeVisible();
        // 화면 전체에서 '특보 없음' 글자는 PC 상태 요약 분류 이름('특보 없음 0곳') 한 곳뿐
        await expect(visibleExactText(page, CLEAR_TITLE)).toHaveCount(1);
      } else {
        const countCard = seaRegion.getByRole("link", {
          name: new RegExp(`^${REGION_NAME} 해변 \\d+곳 지금 상태`),
        });
        await expect(countCard).not.toContainText(CLEAR_TITLE);
        await expect(countCard).toContainText(WARNING_TITLE);
        await expect(countCard).toContainText(UNKNOWN_TITLE);
        await expect(countCard).toContainText(
          confirmedUntil(times.oldestConfirmedAt, expiredMs),
        );
        await expect(visibleExactText(page, CLEAR_TITLE)).toHaveCount(0);
      }

      // 네트워크 실패 배너가 아니라 만료로 인한 '확인 가능한 판단 정보 없음' 배너가 보임
      await expect(
        visibleExactText(page, ko.situationBanner.noConfirmed),
      ).toBeVisible();
      await expect(
        visibleExactText(page, ko.situationBanner.failed),
      ).toHaveCount(0);
      expect(
        data.requests.filter((path) => path.endsWith("/status.json")).length,
      ).toBe(statusBefore);

      await expectNoA11yViolations(page);
    });

    test("탐색 목록: 만료 시 '특보 없음' 묶음이 사라지고 일반 해변·발효 특보 행이 갱신됨", async ({
      page,
      data,
    }) => {
      await page.clock.install({ time: Date.now() });
      await page.goto("/explore/");

      const clearGroup = page.getByRole("region", {
        name: new RegExp(`^${CLEAR_TITLE} \\d+곳$`),
      });
      const blockedGroup = page.getByRole("region", {
        name: new RegExp(`^${ko.home.hero.category.unavailable} \\d+곳$`),
      });
      const unknownGroup = page.getByRole("region", {
        name: new RegExp(`^${ko.home.hero.category.undetermined} \\d+곳$`),
      });

      await expect(clearGroup).toBeVisible();
      await expect(blockedGroup).toBeVisible();
      await expect(unknownGroup).toBeVisible();

      const times = await readSnapshotTimes(page);
      const clearRowBefore = clearGroup.getByRole("link", {
        name: new RegExp(CLEAR_NAME),
      });
      await expect(clearRowBefore).toBeVisible();
      await expect(clearRowBefore).toContainText(CLEAR_TITLE);
      await expect(clearRowBefore).toContainText(
        clearScopeText(times.clearConfirmedAt, times.nowMs),
      );

      const warningRowBefore = blockedGroup.getByRole("link", {
        name: new RegExp(WARNING_NAME),
      });
      await expect(warningRowBefore).toBeVisible();
      await expect(warningRowBefore).toContainText(WARNING_TITLE);

      await expectNoA11yViolations(page);

      const statusBefore = data.requests.filter((path) =>
        path.endsWith("/status.json"),
      ).length;
      data.set("loading");
      const expiredMs = await advanceClockTo(
        page,
        Date.parse(times.validUntil) + 1_000,
      );

      // '특보 없음' 묶음과 배지가 목록 어디에도 남지 않음
      await expect(clearGroup).toHaveCount(0);
      await expect(visibleExactText(page, CLEAR_TITLE)).toHaveCount(0);

      // 일반 해변 행은 판단불가 묶음으로 옮겨지고 '특보 확인 못 함' + 'HH:MM 확인 · 이후 확인 못 함' 표시
      const clearRowAfter = unknownGroup.getByRole("link", {
        name: new RegExp(CLEAR_NAME),
      });
      await expect(clearRowAfter).toBeVisible();
      await expect(clearRowAfter).toContainText(UNKNOWN_TITLE);
      await expect(clearRowAfter).toContainText(
        confirmedUntil(times.clearConfirmedAt, expiredMs),
      );
      await expect(clearRowAfter).not.toContainText(CLEAR_TITLE);

      // 발효 특보 해변 행은 이용불가 묶음에 남고 특보 사유 유지 + 'HH:MM 확인 · 이후 확인 못 함' 표시
      const warningRowAfter = blockedGroup.getByRole("link", {
        name: new RegExp(WARNING_NAME),
      });
      await expect(warningRowAfter).toBeVisible();
      await expect(warningRowAfter).toContainText(WARNING_TITLE);
      await expect(warningRowAfter).toContainText(
        confirmedUntil(times.warningConfirmedAt, expiredMs),
      );

      await expect(
        visibleExactText(page, ko.situationBanner.noConfirmed),
      ).toBeVisible();
      await expect(
        visibleExactText(page, ko.situationBanner.failed),
      ).toHaveCount(0);
      expect(
        data.requests.filter((path) => path.endsWith("/status.json")).length,
      ).toBe(statusBefore);

      await expectNoA11yViolations(page);
    });

    test("장소 상세(특보 없음 해변): 만료 시 '특보 확인 못 함'으로 바뀌고 '특보 없음'이 남지 않음", async ({
      page,
      data,
    }) => {
      await page.clock.install({ time: Date.now() });
      await page.goto(`/spots/${slugOf(CLEAR_ID)}/`);

      await expect(
        page.getByRole("heading", { name: CLEAR_SENTENCE }),
      ).toBeVisible();
      await expect(visibleExactText(page, CLEAR_TITLE).first()).toBeVisible();

      const times = await readSnapshotTimes(page);
      await expect(
        visibleExactText(
          page,
          clearScopeText(times.clearConfirmedAt, times.nowMs),
        ),
      ).toBeVisible();

      await expectNoA11yViolations(page);

      const statusBefore = data.requests.filter((path) =>
        path.endsWith("/status.json"),
      ).length;
      data.set("loading");
      const expiredMs = await advanceClockTo(
        page,
        Date.parse(times.validUntil) + 1_000,
      );

      const verdictRegion = page.getByRole("region", {
        name: UNKNOWN_SENTENCE,
      });
      await expect(verdictRegion).toBeVisible();
      await expect(
        page.getByRole("heading", { name: CLEAR_SENTENCE }),
      ).toHaveCount(0);
      await expect(visibleExactText(page, UNKNOWN_TITLE).first()).toBeVisible();
      await expect(
        verdictRegion.getByText(
          confirmedUntil(times.clearConfirmedAt, expiredMs),
          { exact: true },
        ),
      ).toBeVisible();
      await expect(
        verdictRegion.getByRole("button", { name: ko.detail.verdict.recheck }),
      ).toBeVisible();

      // 배지·확인한 것·대안 해변 어디에도 '특보 없음'이 남지 않음
      await expect(visibleExactText(page, CLEAR_TITLE)).toHaveCount(0);
      await expect(
        page.getByRole("region", { name: ko.detail.alt.title }),
      ).toHaveCount(0);
      await expect(
        visibleExactText(page, ko.situationBanner.noConfirmed),
      ).toBeVisible();
      await expect(
        visibleExactText(page, ko.situationBanner.failed),
      ).toHaveCount(0);
      expect(
        data.requests.filter((path) => path.endsWith("/status.json")).length,
      ).toBe(statusBefore);

      await expectNoA11yViolations(page);
    });

    test("장소 상세(발효 특보 해변): 만료 시 특보 사유를 유지하고 'HH:MM 확인 · 이후 확인 못 함'을 표시하며 대안 '특보 없음'을 숨김", async ({
      page,
      data,
    }) => {
      await page.clock.install({ time: Date.now() });
      await page.goto(`/spots/${slugOf(WARNING_ID)}/`);

      await expect(
        page.getByRole("heading", { name: WARNING_SENTENCE }),
      ).toBeVisible();
      await expect(visibleExactText(page, WARNING_TITLE).first()).toBeVisible();

      // 만료 전에는 대안 해변('가까운 특보 없는 해변')과 '특보 없음' 배지가 보임
      const altRegion = page.getByRole("region", { name: ko.detail.alt.title });
      await expect(altRegion).toBeVisible();
      await expect(altRegion.getByText(CLEAR_TITLE).first()).toBeVisible();

      const times = await readSnapshotTimes(page);
      await expect(
        page.getByText(
          new RegExp(`${issuedText(times.warningPublishedAt, times.nowMs)}$`),
        ),
      ).toBeVisible();

      await expectNoA11yViolations(page);

      const statusBefore = data.requests.filter((path) =>
        path.endsWith("/status.json"),
      ).length;
      data.set("loading");
      const expiredMs = await advanceClockTo(
        page,
        Date.parse(times.validUntil) + 1_000,
      );

      // 특보 사유·결론 문장·확인한 것 칸은 그대로 유지하고 근거 줄만 'HH:MM 확인 · 이후 확인 못 함'으로 바뀜
      const verdictRegion = page.getByRole("region", {
        name: WARNING_SENTENCE,
      });
      await expect(verdictRegion).toBeVisible();
      await expect(visibleExactText(page, WARNING_TITLE).first()).toBeVisible();
      await expect(
        verdictRegion.getByText(
          confirmedUntil(times.warningConfirmedAt, expiredMs),
          { exact: true },
        ),
      ).toBeVisible();

      // 만료 후에는 다른 해변의 '특보 없음'도 보장할 수 없어 대안 해변 묶음과 '특보 없음' 배지가 사라짐
      await expect(altRegion).toHaveCount(0);
      await expect(visibleExactText(page, CLEAR_TITLE)).toHaveCount(0);
      await expect(
        visibleExactText(page, ko.situationBanner.noConfirmed),
      ).toBeVisible();
      await expect(
        visibleExactText(page, ko.situationBanner.failed),
      ).toHaveCount(0);
      expect(
        data.requests.filter((path) => path.endsWith("/status.json")).length,
      ).toBe(statusBefore);

      await expectNoA11yViolations(page);
    });
  });
}

test.describe("validUntil 1분 전 경계값", () => {
  test("홈·탐색 목록·장소 상세에서 validUntil 1분 전에는 아직 '특보 없음'이 유지됨", async ({
    page,
    data,
  }, info) => {
    const desktop = info.project.name === "desktop";
    await page.clock.install({ time: Date.now() });
    await page.goto("/");

    const seaRegion = page.getByRole("region", { name: SEA_TITLE });
    const clearCard = seaRegion.getByRole("link", {
      name: new RegExp(CLEAR_NAME),
    });
    await expect(clearCard).toContainText(CLEAR_TITLE);

    const times = await readSnapshotTimes(page);
    const statusBefore = data.requests.filter((path) =>
      path.endsWith("/status.json"),
    ).length;
    data.set("loading");

    // validUntil 정확히 1분 전으로 시계를 옮김
    const beforeExpiryMs = await advanceClockTo(
      page,
      Date.parse(times.validUntil) - MIN,
    );

    // 1. 홈: 일반 해변 카드와 개수 카드/상태 요약에 '특보 없음' 유지, '이후 확인 못 함' 없음
    await expect(clearCard).toContainText(CLEAR_TITLE);
    await expect(clearCard).toContainText(
      desktop
        ? badgeScopeText(times.clearConfirmedAt, beforeExpiryMs)
        : clearScopeText(times.clearConfirmedAt, beforeExpiryMs),
    );
    await expect(
      page.getByText(confirmedUntil(times.clearConfirmedAt, beforeExpiryMs)),
    ).toHaveCount(0);
    if (desktop) {
      await expect(
        page.getByRole("link", {
          name: new RegExp(`^${ko.home.hero.category.clear} [1-9]`),
        }),
      ).toBeVisible();
    } else {
      const countCard = seaRegion.getByRole("link", {
        name: new RegExp(`^${REGION_NAME} 해변 \\d+곳 지금 상태`),
      });
      await expect(countCard).toContainText(CLEAR_TITLE);
    }

    // 2. 탐색 목록(클라이언트 이동으로 같은 스냅샷·시계 유지): '특보 없음' 묶음과 행 유지
    await page
      .getByRole("link", { name: ko.nav.explore, exact: true })
      .first()
      .click();
    await expect(page).toHaveURL(/\/explore\/$/);
    const clearGroup = page.getByRole("region", {
      name: new RegExp(`^${CLEAR_TITLE} \\d+곳$`),
    });
    await expect(clearGroup).toBeVisible();
    const clearRow = clearGroup.getByRole("link", {
      name: new RegExp(CLEAR_NAME),
    });
    await expect(clearRow).toBeVisible();
    await expect(clearRow).toContainText(CLEAR_TITLE);
    await expect(
      page.getByText(confirmedUntil(times.clearConfirmedAt, beforeExpiryMs)),
    ).toHaveCount(0);

    // 3. 장소 상세(특보 없음 해변으로 클라이언트 이동): '지금 확인된 특보가 없어요'·'특보 없음' 유지
    await clearRow.click();
    await expect(page).toHaveURL(new RegExp(`/spots/${slugOf(CLEAR_ID)}/$`));
    await expect(
      page.getByRole("heading", { name: CLEAR_SENTENCE }),
    ).toBeVisible();
    await expect(visibleExactText(page, CLEAR_TITLE).first()).toBeVisible();
    await expect(
      page.getByRole("heading", { name: UNKNOWN_SENTENCE }),
    ).toHaveCount(0);
    await expect(
      page.getByText(confirmedUntil(times.clearConfirmedAt, beforeExpiryMs)),
    ).toHaveCount(0);

    // 4. 장소 상세(발효 특보 해변으로 클라이언트 이동): 발표 시각 근거와 대안 해변 '특보 없음' 유지
    await page.getByRole("button", { name: ko.nav.back }).first().click();
    await expect(page).toHaveURL(/\/explore\/$/);
    const blockedGroup = page.getByRole("region", {
      name: new RegExp(`^${ko.home.hero.category.unavailable} \\d+곳$`),
    });
    await blockedGroup
      .getByRole("link", { name: new RegExp(WARNING_NAME) })
      .click();
    await expect(page).toHaveURL(new RegExp(`/spots/${slugOf(WARNING_ID)}/$`));
    await expect(
      page.getByRole("heading", { name: WARNING_SENTENCE }),
    ).toBeVisible();
    await expect(
      page
        .getByRole("region", { name: ko.detail.alt.title })
        .getByText(CLEAR_TITLE)
        .first(),
    ).toBeVisible();
    await expect(
      page.getByText(confirmedUntil(times.warningConfirmedAt, beforeExpiryMs)),
    ).toHaveCount(0);
    expect(
      data.requests.filter((path) => path.endsWith("/status.json")).length,
    ).toBe(statusBefore);
  });
});

