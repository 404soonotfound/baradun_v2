import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { HttpResult } from "../core/collect/http";
import { createLogger } from "../core/collect/log";
import { MemoryOpsStore, MemoryStateStore } from "../core/store/memory";
import { unpackItems } from "../core/warnings/archive";
import { collectWarnings, WARNINGS_STATE } from "./warnings";

// collect-warnings (BRD-56). 두 출처를 따로 확인하고 각자 성공했을 때만 그 출처의 확인 시각을 바꾸는지
const fixture = JSON.parse(
  readFileSync(
    new URL("../core/warnings/fixtures/pwncd-response.json", import.meta.url),
    "utf8",
  ),
) as { responses: { id: string; response: unknown }[] };
const response = (id: string) =>
  fixture.responses.find((r) => r.id === id)!.response;
const PWNCD_OK = response("ok-3rows") as {
  response: { body: { items: { item: unknown[] } } };
};
const TSUNAMI_NONE = {
  response: { header: { resultCode: "03", resultMsg: "NO_DATA" } },
};
const NOW = "2026-10-20T15:42:00Z"; // KST 2026-10-21 00:42 → 슬롯 202610210033
const OLD = "2026-10-20T15:00:00Z";
const KEY = "SERVICE+KEY/==";

type Reply = unknown | HttpResult;
const isHttp = (reply: Reply): reply is HttpResult =>
  typeof reply === "object" && reply !== null && "attempts" in reply;

function setup(replies: { pwncd: Reply; tsunami: Reply }) {
  const state = new MemoryStateStore();
  const ops = new MemoryOpsStore();
  const urls: string[] = [];
  const lines: string[] = [];
  const deps = {
    state,
    ops,
    keys: { get: async () => KEY },
    get: async (url: string): Promise<HttpResult> => {
      urls.push(url);
      const reply = url.includes("getPwnCd") ? replies.pwncd : replies.tsunami;
      if (isHttp(reply)) return reply;
      const body = typeof reply === "string" ? reply : JSON.stringify(reply);
      return { status: "ok", body, httpStatus: 200, attempts: 1 };
    },
    log: createLogger(
      () => [KEY],
      (line) => lines.push(line),
    ),
    clock: () => Date.parse(NOW),
    owner: "run-1",
  };
  return { deps, state, urls, lines };
}

async function saved(state: MemoryStateStore, source: "pwncd" | "tsunami") {
  const { pk, sk } = WARNINGS_STATE[source];
  return (await state.getState(pk, sk))?.value as {
    archive: string;
    rowCount: number;
    lastConfirmedAt: string;
  } | null;
}

async function seed(state: MemoryStateStore, source: "pwncd" | "tsunami") {
  const { pk, sk } = WARNINGS_STATE[source];
  await state.putState(
    pk,
    sk,
    { archive: "old", rowCount: 1, lastConfirmedAt: OLD },
    Date.parse(OLD),
  );
}

describe("collectWarnings", () => {
  it("두 출처 모두 정상 → 원본 행 압축 저장, 출처마다 확인 시각 갱신", async () => {
    const { deps, state, urls, lines } = setup({
      pwncd: PWNCD_OK,
      tsunami: TSUNAMI_NONE,
    });
    expect(await collectWarnings(deps)).toEqual({
      status: "complete",
      slotId: "202610210033",
    });
    const pwncd = await saved(state, "pwncd");
    expect(pwncd).toMatchObject({ rowCount: 3, lastConfirmedAt: NOW });
    expect(unpackItems(pwncd!.archive)).toEqual({
      status: "ok",
      items: PWNCD_OK.response.body.items.item,
    });
    // 지진해일 03 = 발표 없음 확인 → 빈 묶음 + 확인 시각
    const tsunami = await saved(state, "tsunami");
    expect(tsunami).toMatchObject({ rowCount: 0, lastConfirmedAt: NOW });
    expect(unpackItems(tsunami!.archive)).toEqual({ status: "ok", items: [] });

    const pwncdUrl = new URL(urls.find((u) => u.includes("getPwnCd"))!);
    expect(Object.fromEntries(pwncdUrl.searchParams)).toMatchObject({
      fromTmFc: "20260823", // KST 10/21 기준 59일 전
      toTmFc: "20261021",
      numOfRows: "10000",
      dataType: "JSON",
      ServiceKey: KEY,
    });
    const tsunamiUrl = new URL(urls.find((u) => u.includes("getTsunamiMsg"))!);
    expect(tsunamiUrl.searchParams.get("fromTmFc")).toBe("20261018");
    expect(lines.join("\n")).not.toContain(KEY);
    expect(lines.join("\n")).not.toContain(encodeURIComponent(KEY));
  });

  it("지진해일만 실패 → getPwnCd는 갱신, 지진해일 확인 시각은 그대로", async () => {
    const { deps, state } = setup({
      pwncd: PWNCD_OK,
      tsunami: { status: "failed", reason: "http:500", attempts: 2 },
    });
    await seed(state, "tsunami");
    expect((await collectWarnings(deps)).status).toBe("partial");
    expect((await saved(state, "pwncd"))?.lastConfirmedAt).toBe(NOW);
    expect((await saved(state, "tsunami"))?.lastConfirmedAt).toBe(OLD);
  });

  it.each([
    ["99 오래된 범위", response("too-old")],
    ["03 NO_DATA는 '특보 없음'이 아님", response("no-data-reversed")],
    ["JSON이 아님", "<html>error</html>"],
  ])(
    "getPwnCd 실패(%s) → getPwnCd 확인 시각은 그대로, 지진해일은 갱신",
    async (_name, reply) => {
      const { deps, state } = setup({ pwncd: reply, tsunami: TSUNAMI_NONE });
      await seed(state, "pwncd");
      expect((await collectWarnings(deps)).status).toBe("partial");
      expect((await saved(state, "pwncd"))?.lastConfirmedAt).toBe(OLD);
      expect((await saved(state, "tsunami"))?.lastConfirmedAt).toBe(NOW);
    },
  );

  it("받은 행이 상한의 70%를 넘으면 운영 알림 로그", async () => {
    const first = PWNCD_OK.response.body.items.item[0];
    const many = structuredClone(PWNCD_OK);
    many.response.body.items.item = Array.from({ length: 7001 }, () => first);
    const { deps, lines } = setup({ pwncd: many, tsunami: TSUNAMI_NONE });
    await collectWarnings(deps);
    expect(lines.map((l) => JSON.parse(l))).toContainEqual(
      expect.objectContaining({
        level: "warn",
        event: "pwncd_rows_near_limit",
        rowCount: 7001,
      }),
    );
  });
});
