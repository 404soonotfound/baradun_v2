import { describe, expect, it } from "vitest";
import { BASE as CATALOG_BASE, CATALOG_JOB } from "../collectors/catalog";
import { BASE as OCEAN_BASE, OCEAN_JOB } from "../collectors/ocean";
import { BASE as RIP_BASE, RIP_JOB } from "../collectors/rip";
import { PWNCD_URL, TSUNAMI_URL, WARNINGS_JOB } from "../collectors/warnings";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ALL_HOURS,
  MID_BASE,
  MID_HOURS,
  SHORT_BASE,
  SHORT_HOURS,
  WEATHER_JOB,
} from "../collectors/weather";
import { ApiKeyMissingError, type ApiKeyTags } from "../core/secrets/api-keys";
import { COLLECTION_JOBS } from "./collection";
import {
  daysLeft,
  readKeys,
  readSources,
  SOURCE_CATALOG,
  SOURCE_URLS,
  WEATHER_HOURS,
} from "./sources";
import type { Sender } from "./writes";

// 데이터 출처 (BRD-149 ADM-SRC). 인증키는 등록 여부·만료일만, 확인 못 하면 '확인 못 함'

const NOW = new Date("2026-11-10T05:00:00Z");

describe("출처 목록", () => {
  it("호출 주소가 수집기 코드의 상수와 같다(옮겨 적은 값이 어긋나지 않게)", () => {
    expect(SOURCE_URLS).toEqual({
      pwncd: PWNCD_URL,
      tsunami: TSUNAMI_URL,
      oceanBase: OCEAN_BASE,
      rip: RIP_BASE,
      weatherShort: SHORT_BASE,
      weatherMid: MID_BASE,
      catalog: CATALOG_BASE,
    });
  });

  it("출처 줄은 수집기 이름·수집 현황 목록과 같은 순서", () => {
    const ids = SOURCE_CATALOG.map((s) => s.id);
    expect(ids).toEqual([...COLLECTION_JOBS]);
    expect(ids).toEqual([
      WARNINGS_JOB,
      OCEAN_JOB,
      RIP_JOB,
      WEATHER_JOB,
      CATALOG_JOB,
    ]);
  });

  it("판단에 쓰는 출처는 특보·해양 관측 둘뿐(G1)", () => {
    expect(SOURCE_CATALOG.filter((s) => s.judgment).map((s) => s.id)).toEqual([
      "collect-warnings",
      "collect-ocean",
    ]);
  });

  it("응답에 인증키 값·키가 들어간 주소가 없다", () => {
    const text = JSON.stringify(SOURCE_CATALOG);
    expect(text).not.toMatch(/ServiceKey|authKey|serviceKey/);
  });
});

function reader(
  tags: Record<string, { Key: string; Value: string }[] | "missing" | "error">,
): ApiKeyTags {
  return {
    async tags(name) {
      const found = tags[name];
      if (found === "missing" || found === undefined)
        throw new ApiKeyMissingError(name);
      if (found === "error") throw new Error("AccessDenied");
      return found;
    },
  };
}

describe("인증키", () => {
  it("등록·만료일 태그를 읽고, 없는 키는 missing, 오류는 unknown(등록 안 됨으로 보지 않음)", async () => {
    const keys = await readKeys(
      reader({
        "data-go-kr": [{ Key: "expires", Value: "2027-03-31" }],
        "kma-apihub": "error",
      }),
      NOW,
    );
    expect(keys).toEqual([
      {
        name: "data-go-kr",
        status: "registered",
        expiresOn: "2027-03-31",
        daysLeft: 141,
        expiresInvalid: false,
      },
      {
        name: "kma-apihub",
        status: "unknown",
        expiresOn: null,
        daysLeft: null,
        expiresInvalid: false,
      },
    ]);
    const missing = await readKeys(reader({}), NOW);
    expect(missing.map((k) => k.status)).toEqual(["missing", "missing"]);
  });

  it("만료일 태그가 없으면 null, 모양이 틀리면 null + expiresInvalid", async () => {
    const keys = await readKeys(
      reader({
        "data-go-kr": [],
        "kma-apihub": [{ Key: "expires", Value: "2027-02-30" }],
      }),
      NOW,
    );
    expect(keys.map((k) => [k.status, k.expiresOn, k.expiresInvalid])).toEqual([
      ["registered", null, false],
      ["registered", null, true],
    ]);
  });

  it("읽는 도구가 없거나 제한 시간을 넘으면 모두 unknown", async () => {
    expect((await readKeys(null, NOW)).map((k) => k.status)).toEqual([
      "unknown",
      "unknown",
    ]);
    const slow: ApiKeyTags = { tags: () => new Promise(() => {}) };
    expect((await readKeys(slow, NOW, 10)).map((k) => k.status)).toEqual([
      "unknown",
      "unknown",
    ]);
  });

  it("한 키만 늦으면 그 키만 unknown이고 먼저 읽힌 키는 그대로", async () => {
    const half: ApiKeyTags = {
      tags: (name) =>
        name.endsWith("data-go-kr")
          ? Promise.resolve([{ Key: "expires", Value: "2027-03-31" }])
          : new Promise(() => {}),
    };
    expect(
      (await readKeys(half, NOW, 10)).map((k) => [k.status, k.expiresOn]),
    ).toEqual([
      ["registered", "2027-03-31"],
      ["unknown", null],
    ]);
  });
});

function client(
  items: Record<string, Record<string, unknown>[]> | "fail",
): Sender & { limits: unknown[] } {
  const limits: unknown[] = [];
  return {
    limits,
    async send(command: { input: Record<string, unknown> }) {
      if (items === "fail") throw new Error("ProvisionedThroughputExceeded");
      const input = command.input as {
        ExpressionAttributeValues: { ":pk": string };
        Limit?: number;
      };
      limits.push(input.Limit);
      return { Items: items[input.ExpressionAttributeValues[":pk"]] ?? [] };
    },
  } as unknown as Sender & { limits: unknown[] };
}

describe("readSources", () => {
  it("출처마다 최근 5건(최신 먼저)과 지연 기준을 붙이고, 기록이 없으면 빈 배열", async () => {
    const run = (startedAt: string, status: string) => ({
      startedAt,
      finishedAt: startedAt,
      status,
      failures: [],
    });
    const fake = client({
      "collect#run#collect-warnings": [
        run("2026-11-10T04:48:00.000Z", "complete"),
        run("2026-11-10T04:33:00.000Z", "failed"),
      ],
    });
    const view = await readSources(fake, "ops", NOW, reader({}));
    expect(fake.limits.every((l) => l === 5)).toBe(true);
    const warnings = view.sources[0]!;
    expect(warnings.recentRuns?.map((r) => r.status)).toEqual([
      "complete",
      "failed",
    ]);
    expect(warnings.lateAfterMinutes).toBe(20);
    expect(view.sources[1]!.recentRuns).toEqual([]);
    // 11월은 이안류 비수기 → 지연 표시 없음
    expect(
      view.sources.find((s) => s.id === "collect-rip")!.lateAfterMinutes,
    ).toBeNull();
    expect(view.generatedAt).toBe(NOW.toISOString());
  });

  it("샘플 계정용(hideKeys)은 키를 읽지 않고 빈 배열 + keysHidden", async () => {
    let called = false;
    const spy: ApiKeyTags = {
      tags: async () => {
        called = true;
        return [];
      },
    };
    const view = await readSources(client({}), "ops", NOW, spy, {
      hideKeys: true,
    });
    expect(called).toBe(false);
    expect(view.keys).toEqual([]);
    expect(view.keysHidden).toBe(true);
    expect(view.sources).toHaveLength(5);
  });

  it("실행 기록을 읽지 못하면 null('기록 없음'과 나눔)", async () => {
    const view = await readSources(client("fail"), "ops", NOW, null);
    expect(view.sources.every((s) => s.recentRuns === null)).toBe(true);
    expect(view.keys.every((k) => k.status === "unknown")).toBe(true);
  });
});

describe("출처 목록 대조 (리뷰 지적)", () => {
  const FILES: Record<string, string> = {
    "collect-warnings": "warnings.ts",
    "collect-ocean": "ocean.ts",
    "collect-rip": "rip.ts",
    "collect-weather": "weather.ts",
    "collect-catalog": "catalog.ts",
  };
  const code = (id: string) =>
    readFileSync(join(__dirname, "../collectors", FILES[id]!), "utf8");

  it("출처별 인증키와 기능 이름이 수집기 코드에 그대로 있다", () => {
    for (const source of SOURCE_CATALOG) {
      const text = code(source.id);
      expect(text, source.id).toContain(`keys.get("${source.key}")`);
      for (const call of source.calls) {
        expect(text, `${source.id} ${call.operation}`).toContain(
          call.operation,
        );
      }
    }
  });

  it("날씨 발표 시각이 수집기 값과 같고, 단기·중기는 발표 때만 부른다", () => {
    expect(WEATHER_HOURS).toEqual({
      now: ALL_HOURS,
      short: SHORT_HOURS,
      mid: MID_HOURS,
    });
    const weather = SOURCE_CATALOG.find((s) => s.id === "collect-weather")!;
    expect(
      weather.calls.map((c) => [c.operation, c.issued?.hoursKst.length]),
    ).toEqual([
      ["getUltraSrtNcst", 24],
      ["getVilageFcst", 8],
      ["getMidLandFcst", 2],
      ["getMidTa", 2],
    ]);
    expect(weather.extraRetryMax).not.toBeNull();
    expect(weather.budgetMs).not.toBeNull();
  });
});

describe("최근 실행·공통 정책 (리뷰 지적)", () => {
  it("시각이 없어 읽지 못한 기록은 버리지 않고 수를 알림", async () => {
    const fake = client({
      "collect#run#collect-warnings": [
        { status: "failed", failures: [] },
        {
          startedAt: "2026-11-10T04:33:00.000Z",
          finishedAt: "2026-11-10T04:33:01.000Z",
          status: "complete",
          failures: [],
        },
      ],
    });
    const view = await readSources(fake, "ops", NOW, null);
    expect(view.sources[0]!.recentRuns).toHaveLength(1);
    expect(view.sources[0]!.unreadableRuns).toBe(1);
    expect(view.sources[1]!.unreadableRuns).toBe(0);
  });

  it("HTTP 시간 제한·다시 시도는 출처마다가 아니라 맨 위에 한 번", async () => {
    const view = await readSources(client({}), "ops", NOW, null);
    expect(view.http).toEqual({ timeoutMs: 10_000, retries: 1 });
    expect(view.sources[0]).not.toHaveProperty("timeoutMs");
  });
});

describe("인증키 만료·취소 (리뷰 지적)", () => {
  it("남은 날은 KST 날짜로 셈(KST 자정 직후에도 하루 어긋나지 않음)", () => {
    // 2026-11-10 15:30 UTC = 11-11 00:30 KST
    const now = new Date("2026-11-10T15:30:00Z");
    expect(daysLeft("2026-11-11", now)).toBe(0);
    expect(daysLeft("2026-11-10", now)).toBe(-1);
    expect(daysLeft("2026-12-11", now)).toBe(30);
  });

  it("제한 시간을 넘으면 남은 요청에 취소 신호를 보냄", async () => {
    let aborted = false;
    const slow: ApiKeyTags = {
      tags: (_name, signal) =>
        new Promise((_, reject) => {
          signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("AbortError"));
          });
        }),
    };
    const keys = await readKeys(slow, NOW, 10);
    expect(keys.map((k) => k.status)).toEqual(["unknown", "unknown"]);
    expect(aborted).toBe(true);
  });
});
