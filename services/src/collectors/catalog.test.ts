import { describe, expect, it } from "vitest";
import type { HttpResult } from "../core/collect/http";
import { createLogger } from "../core/collect/log";
import { MemoryOpsStore, MemoryStateStore } from "../core/store/memory";
import {
  CATALOG_STATE,
  collectCatalog,
  parsePhotoLedger,
  staleFirst,
  type PhotoRecord,
  type PhotoSource,
} from "./catalog";

// collect-catalog (BRD-58). 사진 유형을 다시 확인해 결과만 저장, 실패한 해변은 이전 결과 유지

const NOW = "2026-10-22T19:21:00Z"; // KST 10/23 04:21 → 슬롯 202610230420
const KEY = "SERVICE+KEY/==";
const A: PhotoSource = {
  beachId: "b0001",
  url: "https://x/a.jpg",
  contentId: "1",
  image: "first",
};
const B: PhotoSource = {
  beachId: "b0002",
  url: "https://x/b.jpg",
  contentId: "2",
  image: "detail",
};

const common = (contentid: string, firstimage: string, cpyrhtDivCd: string) =>
  JSON.stringify({
    response: {
      header: { resultCode: "0000" },
      body: { items: { item: [{ contentid, firstimage, cpyrhtDivCd }] } },
    },
  });
const images = (originimgurl: string, cpyrhtDivCd: string) =>
  JSON.stringify({
    response: {
      header: { resultCode: "0000" },
      body: { items: { item: [{ originimgurl, cpyrhtDivCd }] } },
    },
  });

function setup(
  reply: (url: string) => string | HttpResult,
  options: { nowMs?: () => number; key?: string | null } = {},
) {
  const state = new MemoryStateStore();
  const ops = new MemoryOpsStore();
  const urls: string[] = [];
  const lines: string[] = [];
  const deps = (photos: readonly PhotoSource[] = [A, B]) => ({
    state,
    ops,
    keys: {
      get: async () => {
        if (options.key === null) throw new Error("no key");
        return options.key ?? KEY;
      },
    },
    get: async (url: string): Promise<HttpResult> => {
      urls.push(url);
      const r = reply(url);
      return typeof r === "string"
        ? { status: "ok", body: r, httpStatus: 200, attempts: 1 }
        : r;
    },
    log: createLogger(
      () => [KEY],
      (line) => lines.push(line),
    ),
    clock: options.nowMs ?? (() => Date.parse(NOW)),
    owner: "run-1",
    photos,
  });
  const saved = async () =>
    (
      (await state.getState(CATALOG_STATE.photos.pk, CATALOG_STATE.photos.sk))
        ?.value as { beaches: Record<string, PhotoRecord> } | undefined
    )?.beaches;
  return { state, ops, deps, urls, lines, saved };
}

describe("collectCatalog", () => {
  it("대표 이미지는 detailCommon2, 상세 이미지는 detailImage2로 확인해 결과를 저장", async () => {
    const { deps, urls, saved, ops } = setup((url) =>
      url.includes("detailCommon2")
        ? common("1", A.url, "Type1")
        : images(B.url, "Type3"),
    );
    expect(await collectCatalog(deps())).toEqual({
      status: "complete",
      slotId: "202610230420",
    });
    expect(
      urls.some(
        (u) => u.includes("detailCommon2") && u.includes("contentId=1"),
      ),
    ).toBe(true);
    expect(
      urls.some((u) => u.includes("detailImage2") && u.includes("contentId=2")),
    ).toBe(true);
    expect(await saved()).toEqual({
      b0001: { status: "type1", url: A.url, checkedAt: NOW },
      b0002: { status: "not_type1", url: B.url, checkedAt: NOW },
    });
    // 같은 날 다시 실행하지 않음
    expect(
      await ops.claimSlot(
        "collect-catalog",
        "202610230420",
        "x",
        Date.parse(NOW),
        1,
      ),
    ).toBe("done");
  });

  it("한 해변 호출이 실패하면 그 해변은 이전 결과 유지, 슬롯은 끝내지 않음(재시도가 메움)", async () => {
    let fail = false;
    const { deps, saved, lines } = setup((url) =>
      fail && url.includes("detailImage2")
        ? { status: "failed", reason: "timeout", attempts: 2 }
        : url.includes("detailCommon2")
          ? common("1", A.url, "Type1")
          : images(B.url, "Type1"),
    );
    await collectCatalog(deps());
    fail = true;
    // 다음 날 슬롯
    const next = {
      ...deps(),
      clock: () => Date.parse(NOW) + 24 * 60 * 60 * 1000,
    };
    expect((await collectCatalog(next)).status).toBe("partial");
    const beaches = await saved();
    expect(beaches?.b0002).toEqual({
      status: "type1",
      url: B.url,
      checkedAt: NOW,
    });
    expect(beaches?.b0001?.checkedAt).toBe("2026-10-23T19:21:00Z");
    expect(lines.some((l) => l.includes("catalog_photo_failed"))).toBe(true);
  });

  it("1유형이 아니게 됐거나 사진을 찾지 못하면 경고 로그(해변 id·관광지 id)", async () => {
    const { deps, lines } = setup((url) =>
      url.includes("detailCommon2")
        ? common("1", "https://x/changed.jpg", "Type1")
        : images(B.url, "Type3"),
    );
    await collectCatalog(deps());
    const warns = lines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((l) => l.event === "catalog_photo_rejected");
    expect(warns.map((w) => [w.beachId, w.contentId, w.status])).toEqual([
      ["b0001", "1", "missing"],
      ["b0002", "2", "not_type1"],
    ]);
  });

  it("모든 호출이 실패하면 partial이 아니라 failed, 저장 기록도 바꾸지 않음", async () => {
    const { deps, state } = setup(() => ({
      status: "failed",
      reason: "timeout",
      attempts: 2,
    }));
    expect((await collectCatalog(deps())).status).toBe("failed");
    expect(
      await state.getState(CATALOG_STATE.photos.pk, CATALOG_STATE.photos.sk),
    ).toBeNull();
  });

  it("키를 읽지 못하면 호출하지 않고 실패, 이전 결과는 그대로", async () => {
    const { deps, urls } = setup(() => common("1", A.url, "Type1"), {
      key: null,
    });
    expect((await collectCatalog(deps())).status).toBe("failed");
    expect(urls).toEqual([]);
  });

  it("시간 예산이 지나면 새 요청을 보내지 않음(남은 해변은 미확인)", async () => {
    let now = Date.parse(NOW);
    const { deps, urls } = setup(
      () => {
        now += 31_000; // 요청 하나에 31초
        return common("1", A.url, "Type1");
      },
      { nowMs: () => now },
    );
    const many = Array.from({ length: 10 }, (_, i) => ({
      ...A,
      beachId: `b${i}`,
    }));
    const result = await collectCatalog(deps(many));
    expect(result.status).toBe("partial");
    expect(urls.length).toBeLessThan(many.length);
  });

  it("로그에 API 키가 남지 않음", async () => {
    const { deps, lines } = setup(() => ({
      status: "failed",
      reason: `x serviceKey=${KEY}`,
      attempts: 1,
    }));
    await collectCatalog(deps());
    expect(lines.join("\n")).not.toContain(KEY);
  });
});

describe("staleFirst", () => {
  const record = (url: string, checkedAt: string) =>
    ({ status: "type1", url, checkedAt }) as const;

  it("기록 없음·사진 바뀜이 맨 앞, 그다음 확인이 오래된 순", () => {
    const photos = [
      { ...A, beachId: "b1" }, // 어제 확인
      { ...A, beachId: "b2" }, // 기록 없음
      { ...A, beachId: "b3" }, // 그제 확인
      { ...A, beachId: "b4" }, // 기록 url이 지금 사진과 다름(사진 바뀜)
    ];
    const ordered = staleFirst(photos, {
      b1: record(A.url, "2026-10-22T19:21:00Z"),
      b3: record(A.url, "2026-10-21T19:21:00Z"),
      b4: record("https://x/old.jpg", "2026-10-22T19:21:00Z"),
    });
    expect(ordered.map((s) => s.beachId)).toEqual(["b2", "b4", "b3", "b1"]);
  });

  it("시간 예산으로 끊긴 다음 실행은 미확인 사진부터 요청함", async () => {
    // 세 해변 중 b0001만 확인된 기록이 있음 → 다음 실행의 첫 요청은 미확인 해변
    const { state, deps, urls } = setup((url) =>
      url.includes("detailCommon2")
        ? common("9", "https://x/n.jpg", "Type1")
        : images(B.url, "Type1"),
    );
    await state.putState(
      CATALOG_STATE.photos.pk,
      CATALOG_STATE.photos.sk,
      {
        beaches: { b0001: record(A.url, "2026-10-21T19:21:00Z") },
      } as never,
      1,
    );
    await collectCatalog(deps([A, B]));
    // B(b0002)는 기록이 없어 A(b0001)보다 먼저 요청됨
    expect(urls[0]).toContain("contentId=2");
  });
});

describe("parsePhotoLedger", () => {
  it("대장을 해변 id 순 확인 목록으로 바꿈", () => {
    expect(
      parsePhotoLedger({
        _meta: { note: "" },
        beaches: {
          b0002: { contentId: "2", title: "나", image: "detail", url: B.url },
          b0001: { contentId: "1", title: "가", image: "first", url: A.url },
        },
      }),
    ).toEqual([
      { beachId: "b0001", url: A.url, contentId: "1", image: "first" },
      { beachId: "b0002", url: B.url, contentId: "2", image: "detail" },
    ]);
  });

  it("모양이 틀리면 빼고 돌지 않고 멈춤(번들 문제)", () => {
    expect(() => parsePhotoLedger(null)).toThrow(RangeError);
    expect(() => parsePhotoLedger({})).toThrow("beaches 칸이 없음");
    for (const entry of [
      { contentId: "x1", image: "first", url: A.url }, // 숫자가 아닌 id
      { contentId: "1", image: "both", url: A.url }, // 모르는 이미지 종류
      { contentId: "1", image: "first", url: "http://x/a.jpg" }, // https 아님
      { contentId: "1", image: "first" }, // url 없음
      null,
    ]) {
      expect(() => parsePhotoLedger({ beaches: { b0001: entry } })).toThrow(
        "항목 형식 오류: b0001",
      );
    }
  });

  it("실제 대장(data/photo-sources.json)이 그대로 읽힘", async () => {
    const ledger = (await import("../../../data/photo-sources.json")) as {
      default: unknown;
    };
    const sources = parsePhotoLedger(ledger.default);
    expect(sources.length).toBeGreaterThan(0);
    expect(sources[0]!.beachId < sources.at(-1)!.beachId).toBe(true);
  });
});
