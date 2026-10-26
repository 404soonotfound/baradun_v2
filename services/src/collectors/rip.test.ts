import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import ledger from "../../../data/rip-current-beaches.json";
import type { HttpResult } from "../core/collect/http";
import { createLogger } from "../core/collect/log";
import { MemoryOpsStore, MemoryStateStore } from "../core/store/memory";
import type { StateValue } from "../core/store/types";
import { inRipSeason } from "../core/rip/rip-current";
import {
  collectRip,
  parseRipLedger,
  RIP_JOB,
  RIP_STATE,
  type RipSource,
} from "./rip";

// collect-rip (BRD-57). HTTP·키·저장소를 가짜로 바꿔 실패 경로를 확인
// 응답 본문은 실응답 픽스처(2026-08-15 송정, 줄 줄임)
const REAL = readFileSync(
  new URL("../core/rip/fixtures/rip-songjung-20260815.json", import.meta.url),
  "utf8",
);
const IN_SEASON = "2026-08-15T15:13:00Z"; // KST 08-16 00:13 → 슬롯 202608160012
// 픽스처 날짜를 요청한 날로 바꿈(수집기는 요청한 날의 줄만 씀). 23:55 줄은 00:05로 바꿔 미래 관측이 아니게 함
const realOn = (day: string) =>
  REAL.replaceAll("2026-08-15", day).replace("23:55", "00:05");
const KEY = "RIP-KEY-SECRET";
const SOURCES: RipSource[] = [
  { code: "SONGJUNG", beachId: "b0096" },
  { code: "HAE", beachId: "b0097" },
];

type Reply = string | HttpResult;
const ok = (body: string): HttpResult => ({
  status: "ok",
  body,
  httpStatus: 200,
  attempts: 1,
});
const NO_DATA = JSON.stringify({
  header: { resultCode: "03", resultMsg: "NODATA_ERROR" },
  body: { items: "", totalCount: 0 },
});

function setup(now: string, replies: Record<string, Reply>) {
  const state = new MemoryStateStore();
  const ops = new MemoryOpsStore();
  const urls: string[] = [];
  const lines: string[] = [];
  const deps = {
    state,
    ops,
    keys: { get: async () => KEY },
    get: async (url: string) => {
      urls.push(url);
      const code = new URL(url).searchParams.get("beachCode")!;
      const reply = replies[code] ?? NO_DATA;
      return typeof reply === "string" ? ok(reply) : reply;
    },
    log: createLogger(
      () => [KEY],
      (line) => lines.push(line),
    ),
    clock: () => Date.parse(now),
    owner: "run-1",
    sources: SOURCES,
  };
  return { deps, state, ops, urls, lines };
}

const readings = async (state: MemoryStateStore) =>
  ((await state.getState(RIP_STATE.readings.pk, RIP_STATE.readings.sk))
    ?.value ?? null) as { beaches: Record<string, unknown> } | null;
const attempt = async (state: MemoryStateStore) =>
  (await state.getState(RIP_STATE.attempt.pk, RIP_STATE.attempt.sk))
    ?.value as Record<string, StateValue>;
const seed = (state: MemoryStateStore, beaches: Record<string, unknown>) =>
  state.putState(
    RIP_STATE.readings.pk,
    RIP_STATE.readings.sk,
    { beaches } as never,
    1,
  );

describe("collectRip", () => {
  it("시즌 중: 해변마다 오늘(KST) 자료를 받아 가장 늦은 관측만 저장, 슬롯 끝냄", async () => {
    const { deps, state, ops, urls, lines } = setup(IN_SEASON, {
      SONGJUNG: realOn("2026-08-16"),
      HAE: realOn("2026-08-16").replaceAll("SONGJUNG", "HAE"),
    });
    expect(await collectRip(deps)).toEqual({
      status: "complete",
      slotId: "202608160012",
    });
    expect(urls).toHaveLength(2);
    expect(
      urls.every(
        (url) => new URL(url).searchParams.get("reqDate") === "20260816",
      ),
    ).toBe(true);
    expect((await readings(state))?.beaches).toEqual({
      b0096: {
        code: "SONGJUNG",
        label: "관심",
        observedAt: "2026-08-15T15:05:00Z",
      },
      b0097: {
        code: "HAE",
        label: "관심",
        observedAt: "2026-08-15T15:05:00Z",
      },
    });
    expect((await attempt(state)).counts).toEqual({
      ok: 2,
      none: 0,
      failed: 0,
    });
    expect(
      await ops.claimSlot(
        RIP_JOB,
        "202608160012",
        "run-2",
        Date.parse(IN_SEASON),
        1,
      ),
    ).toBe("done");
    expect(lines.join("\n")).not.toContain(KEY);
    expect(urls.join("\n")).toContain(KEY); // 키는 요청 주소에만
  });

  it("실패·자료 없음은 저장값을 덮지 않고, 실패가 있으면 슬롯을 끝내지 않음", async () => {
    const previous = {
      b0096: {
        code: "SONGJUNG",
        label: "경계",
        observedAt: "2026-08-15T14:00:00Z",
      },
      b0097: { code: "HAE", label: "주의", observedAt: "2026-08-15T14:00:00Z" },
    };
    const { deps, state, ops } = setup(IN_SEASON, {
      SONGJUNG: { status: "failed", reason: "timeout", attempts: 2 },
      HAE: "{}", // 200인데 모양이 다름 → 실패
    });
    await seed(state, previous);
    expect((await collectRip(deps)).status).toBe("failed");
    expect((await readings(state))?.beaches).toEqual(previous);
    expect((await attempt(state)).sources).toEqual({
      b0096: { status: "failed", reason: "timeout" },
      b0097: { status: "failed", reason: "format:shape" },
    });
    expect(
      await ops.claimSlot(
        RIP_JOB,
        "202608160012",
        "run-2",
        Date.parse(IN_SEASON),
        1,
      ),
    ).toBe("busy");
  });

  it("시즌 중 '자료 없음'은 결측 → error 로그, 슬롯을 끝내지 않음(partial)", async () => {
    const { deps, state, ops, lines } = setup(IN_SEASON, {
      SONGJUNG: realOn("2026-08-16"),
      // HAE는 NO_DATA(기본)
    });
    expect((await collectRip(deps)).status).toBe("partial");
    expect((await attempt(state)).counts).toEqual({
      ok: 1,
      none: 1,
      failed: 0,
    });
    expect(
      lines.some(
        (line) => line.includes("rip_source_no_data") && line.includes("b0097"),
      ),
    ).toBe(true);
    expect(
      await ops.claimSlot(
        RIP_JOB,
        "202608160012",
        "run-2",
        Date.parse(IN_SEASON),
        1,
      ),
    ).toBe("busy");
  });

  it("같은 시각의 정정은 반영하고, 미래 시각 저장값은 믿지 않고 덮음", async () => {
    const { deps, state } = setup(IN_SEASON, {
      SONGJUNG: realOn("2026-08-16"), // 마지막 줄 00:05 '관심'
      HAE: realOn("2026-08-16").replaceAll("SONGJUNG", "HAE"),
    });
    await seed(state, {
      b0096: {
        code: "SONGJUNG",
        label: "위험",
        observedAt: "2026-08-15T15:05:00Z",
      }, // 같은 시각
      b0097: { code: "HAE", label: "위험", observedAt: "2026-08-20T00:00:00Z" }, // 미래
    });
    await collectRip(deps);
    const saved = (await readings(state))!.beaches;
    expect(saved.b0096).toMatchObject({
      label: "관심",
      observedAt: "2026-08-15T15:05:00Z",
    });
    expect(saved.b0097).toMatchObject({
      label: "관심",
      observedAt: "2026-08-15T15:05:00Z",
    });
  });

  it("호출이 모두 실패해도 대응표 밖·코드가 바뀐 이전 값은 버림", async () => {
    const { deps, state, lines } = setup(IN_SEASON, {});
    await seed(state, {
      b0096: {
        code: "SONGJUNG",
        label: "관심",
        observedAt: "2026-08-15T14:00:00Z",
      },
      b0124: {
        code: "DAECHON",
        label: "주의",
        observedAt: "2026-08-15T14:00:00Z",
      },
    });
    const result = await collectRip({
      ...deps,
      keys: { get: async () => Promise.reject(new Error("throttled")) },
    });
    expect(result.status).toBe("failed");
    expect(Object.keys((await readings(state))!.beaches)).toEqual(["b0096"]);
    expect(lines.some((line) => line.includes("rip_readings_dropped"))).toBe(
      true,
    );
  });

  it("대응표에서 빠졌거나 코드가 바뀐 해변의 이전 값은 다음 저장 때 버림", async () => {
    const { deps, state } = setup(IN_SEASON, {
      SONGJUNG: realOn("2026-08-16"),
    });
    await seed(state, {
      b0124: {
        code: "DAECHON",
        label: "주의",
        observedAt: "2026-08-15T14:00:00Z",
      },
      b0097: {
        code: "OLDCODE",
        label: "주의",
        observedAt: "2026-08-15T14:00:00Z",
      },
    });
    await collectRip(deps);
    expect(Object.keys((await readings(state))!.beaches)).toEqual(["b0096"]);
  });

  it("더 이른 관측은 저장된 더 늦은 관측을 덮지 않음", async () => {
    const later = {
      code: "SONGJUNG",
      label: "위험",
      observedAt: "2026-08-15T15:10:00Z",
    };
    const { deps, state } = setup(IN_SEASON, {
      SONGJUNG: realOn("2026-08-16"),
    });
    await seed(state, { b0096: later });
    await collectRip(deps);
    expect((await readings(state))?.beaches.b0096).toEqual(later);
  });

  it("문구가 4단계가 아니어도 원문 그대로 저장(게시 때 숨김)하고 수집 때 한 번 warn", async () => {
    const { deps, state, lines } = setup(IN_SEASON, {
      SONGJUNG: realOn("2026-08-16").replaceAll('"관심"', '"점검중"'),
    });
    await collectRip(deps);
    expect((await readings(state))?.beaches.b0096).toMatchObject({
      label: "점검중",
    });
    expect(
      lines.filter((line) => line.includes("rip_unknown_label")),
    ).toHaveLength(1);
  });

  it("비수기 다른 슬롯은 슬롯을 맡지도 호출하지도 않음", async () => {
    const { deps, urls, ops } = setup("2026-10-26T03:13:00Z", {});
    expect(await collectRip(deps)).toEqual({
      status: "skipped",
      slotId: "202610261212",
      claim: "off_season",
    });
    expect(urls).toEqual([]);
    expect(await ops.claimSlot(RIP_JOB, "202610261212", "run-2", 0, 1)).toBe(
      "claimed",
    );
  });

  it("비수기 하루 1회 슬롯(KST 04:12)은 호출하고, 자료가 나오면 알림", async () => {
    const { deps, urls, lines } = setup("2026-10-25T19:13:00Z", {
      SONGJUNG: realOn("2026-10-26"),
    });
    expect((await collectRip(deps)).status).toBe("complete");
    expect(urls).toHaveLength(2);
    expect(new URL(urls[0]!).searchParams.get("reqDate")).toBe("20261026");
    expect(lines.some((line) => line.includes("rip_off_season_data"))).toBe(
      true,
    );
  });

  it("API 키를 읽지 못하면 호출하지 않고 모두 실패", async () => {
    const { deps, urls, state } = setup(IN_SEASON, {});
    const result = await collectRip({
      ...deps,
      keys: { get: async () => Promise.reject(new Error("throttled")) },
    });
    expect(result.status).toBe("failed");
    expect(urls).toEqual([]);
    expect(await readings(state)).toBeNull();
  });
});

describe("inRipSeason", () => {
  it.each([
    ["2026-05-31T14:59:00Z", false], // KST 05-31 23:59
    ["2026-05-31T15:00:00Z", true], // KST 06-01 00:00
    ["2026-09-30T14:59:00Z", true], // KST 09-30 23:59
    ["2026-09-30T15:00:00Z", false], // KST 10-01 00:00
  ])("%s → %s", (iso, expected) => {
    expect(inRipSeason(Date.parse(iso))).toBe(expected);
  });
});

describe("parseRipLedger", () => {
  it("저장소 대응표: 연결된 해변만 수집 목록에 들어감", () => {
    const sources = parseRipLedger(ledger);
    expect(sources.map((s) => `${s.code}:${s.beachId}`)).toEqual(
      expect.arrayContaining(["SONGJUNG:b0096", "MANGSANG:b0049"]),
    );
    // 망상리조트(b0050)와 확인 대기·미등록은 없음
    expect(sources.some((s) => s.beachId === "b0050")).toBe(false);
    expect(sources.some((s) => s.code === "GORAEBUL")).toBe(false);
  });

  it("연결된 해변 id는 모두 data/beaches에 있음(오타·없는 해변에 값이 가지 않게)", () => {
    const dir = new URL("../../../data/beaches/", import.meta.url);
    for (const source of parseRipLedger(ledger)) {
      const beach = JSON.parse(
        readFileSync(new URL(`${source.beachId}.json`, dir), "utf8"),
      ) as { id: string };
      expect(beach.id).toBe(source.beachId);
    }
  });

  it.each([
    ["목록 없음", {}],
    [
      "코드 형식",
      { beaches: [{ code: "x", status: "mapped", beachId: "b0001" }] },
    ],
    [
      "해변 id 형식",
      { beaches: [{ code: "HAE", status: "mapped", beachId: "1" }] },
    ],
    [
      "모르는 상태",
      { beaches: [{ code: "HAE", status: "maybe", beachId: "b0001" }] },
    ],
    [
      "같은 코드가 연결·확인 대기에 함께",
      {
        beaches: [
          { code: "HAE", status: "mapped", beachId: "b0001" },
          { code: "HAE", status: "pending", beachId: null },
        ],
      },
    ],
    [
      "같은 해변 두 번",
      {
        beaches: [
          { code: "HAE", status: "mapped", beachId: "b0001" },
          { code: "SONGJUNG", status: "mapped", beachId: "b0001" },
        ],
      },
    ],
  ])("형식이 틀리면 멈춤: %s", (_, json) => {
    expect(() => parseRipLedger(json)).toThrow(RangeError);
  });
});
