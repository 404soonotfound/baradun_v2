import { describe, expect, it } from "vitest";
import { getText } from "./http";

// 수집 HTTP (BRD-56: 재시도·시간 제한)
const URL = "https://example.test/api?authKey=SECRET";

// 순서대로 응답을 돌려주는 가짜 fetch. 함수면 호출, Error면 던짐
function fakeFetch(steps: (Response | Error | "hang")[]) {
  let calls = 0;
  const fetchFn = (async (_url: string, init?: RequestInit) => {
    const step = steps[Math.min(calls, steps.length - 1)]!;
    calls += 1;
    if (step === "hang") {
      // 응답하지 않다가 시간 제한 신호가 오면 끊김
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(init.signal!.reason),
        );
      });
    }
    if (step instanceof Error) throw step;
    return step;
  }) as typeof fetch;
  return { fetchFn, calls: () => calls };
}

describe("getText", () => {
  it("정상 응답은 본문을 돌려줌", async () => {
    const { fetchFn } = fakeFetch([
      new Response("#START7777", { status: 200 }),
    ]);
    expect(
      await getText(URL, { timeoutMs: 1000, retries: 1, fetchFn }),
    ).toEqual({
      status: "ok",
      body: "#START7777",
      httpStatus: 200,
      attempts: 1,
    });
  });

  it("5xx는 다시 시도하고 두 번째가 정상이면 정상", async () => {
    const { fetchFn, calls } = fakeFetch([
      new Response("", { status: 503 }),
      new Response("ok", { status: 200 }),
    ]);
    const result = await getText(URL, { timeoutMs: 1000, retries: 1, fetchFn });
    expect(result).toMatchObject({ status: "ok", attempts: 2 });
    expect(calls()).toBe(2);
  });

  it("4xx는 다시 시도하지 않음", async () => {
    const { fetchFn, calls } = fakeFetch([new Response("", { status: 401 })]);
    expect(
      await getText(URL, { timeoutMs: 1000, retries: 2, fetchFn }),
    ).toEqual({ status: "failed", reason: "http:401", attempts: 1 });
    expect(calls()).toBe(1);
  });

  it("시간 초과가 이어지면 재시도를 다 쓰고 실패(timeout)", async () => {
    const { fetchFn, calls } = fakeFetch(["hang"]);
    expect(await getText(URL, { timeoutMs: 20, retries: 1, fetchFn })).toEqual({
      status: "failed",
      reason: "timeout",
      attempts: 2,
    });
    expect(calls()).toBe(2);
  });

  it("연결 실패는 network. 사유에 주소·키를 넣지 않음", async () => {
    const { fetchFn } = fakeFetch([new TypeError(`fetch failed ${URL}`)]);
    const result = await getText(URL, { timeoutMs: 1000, retries: 0, fetchFn });
    expect(result).toEqual({
      status: "failed",
      reason: "network",
      attempts: 1,
    });
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });
});
