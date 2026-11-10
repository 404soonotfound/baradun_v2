import { describe, expect, it } from "vitest";
import { BASE as CATALOG_BASE, CATALOG_JOB } from "../collectors/catalog";
import { BASE as OCEAN_BASE, OCEAN_JOB } from "../collectors/ocean";
import { BASE as RIP_BASE, RIP_JOB } from "../collectors/rip";
import { PWNCD_URL, TSUNAMI_URL, WARNINGS_JOB } from "../collectors/warnings";
import { MID_BASE, SHORT_BASE, WEATHER_JOB } from "../collectors/weather";
import { COLLECTION_JOBS } from "./collection";
import {
  KeyMissingError,
  readKeys,
  readSources,
  SOURCE_CATALOG,
  SOURCE_URLS,
  type KeyTagReader,
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
): KeyTagReader {
  return {
    async tags(name) {
      const found = tags[name];
      if (found === "missing" || found === undefined)
        throw new KeyMissingError(name);
      if (found === "error") throw new Error("AccessDenied");
      return found;
    },
  };
}

describe("인증키", () => {
  it("등록·만료일 태그를 읽고, 없는 키는 missing, 오류는 unknown(등록 안 됨으로 보지 않음)", async () => {
    const keys = await readKeys(
      reader({
        "/baradun/v2/api-keys/data-go-kr": [
          { Key: "expires", Value: "2027-03-31" },
        ],
        "/baradun/v2/api-keys/kma-apihub": "error",
      }),
    );
    expect(keys).toEqual([
      {
        name: "data-go-kr",
        status: "registered",
        expiresOn: "2027-03-31",
        expiresInvalid: false,
      },
      {
        name: "kma-apihub",
        status: "unknown",
        expiresOn: null,
        expiresInvalid: false,
      },
    ]);
    const missing = await readKeys(reader({}));
    expect(missing.map((k) => k.status)).toEqual(["missing", "missing"]);
  });

  it("만료일 태그가 없으면 null, 모양이 틀리면 null + expiresInvalid", async () => {
    const keys = await readKeys(
      reader({
        "/baradun/v2/api-keys/data-go-kr": [],
        "/baradun/v2/api-keys/kma-apihub": [
          { Key: "expires", Value: "2027-02-30" },
        ],
      }),
    );
    expect(keys.map((k) => [k.status, k.expiresOn, k.expiresInvalid])).toEqual([
      ["registered", null, false],
      ["registered", null, true],
    ]);
  });

  it("읽는 도구가 없거나 제한 시간을 넘으면 모두 unknown", async () => {
    expect((await readKeys(null)).map((k) => k.status)).toEqual([
      "unknown",
      "unknown",
    ]);
    const slow: KeyTagReader = { tags: () => new Promise(() => {}) };
    expect((await readKeys(slow, 10)).map((k) => k.status)).toEqual([
      "unknown",
      "unknown",
    ]);
  });

  it("한 키만 늦으면 그 키만 unknown이고 먼저 읽힌 키는 그대로", async () => {
    const half: KeyTagReader = {
      tags: (name) =>
        name.endsWith("data-go-kr")
          ? Promise.resolve([{ Key: "expires", Value: "2027-03-31" }])
          : new Promise(() => {}),
    };
    expect(
      (await readKeys(half, 10)).map((k) => [k.status, k.expiresOn]),
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
    const spy: KeyTagReader = {
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
