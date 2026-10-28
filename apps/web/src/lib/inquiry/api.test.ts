import { describe, expect, it, vi } from "vitest";

import { sendInquiry, sha256Hex, type SendDeps } from "./api";

// 데이터 문의 보내기 (BRD-37 · infra/README): 실제 서버로 보내지 않고 가짜 fetch로 확인

const PHOTO_ID = "0123456789abcdef";
const KEY = `pending/${"a".repeat(32)}/${PHOTO_ID}`;
const INQUIRY_ID = "123e4567-e89b-42d3-a456-426614174000";
const request = {
  type: "data_error" as const,
  message: "[유형]\n\n파고가 달라요",
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

function deps(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
) {
  const fetch = vi.fn((url: string, init: RequestInit) =>
    Promise.resolve(handler(url, init)),
  );
  const value: SendDeps = {
    fetch: fetch as unknown as typeof globalThis.fetch,
    digest: (text) => sha256Hex(text),
    online: () => true,
  };
  return { deps: value, fetch };
}

const created = (photos: unknown[] = []) =>
  json(201, {
    inquiryId: INQUIRY_ID,
    receivedAt: "2026-10-28T03:00:00Z",
    photos,
  });

describe("sendInquiry", () => {
  it("본문 SHA-256을 헤더에 넣고, 해시한 그 문자열을 보냄", async () => {
    const { deps: d, fetch } = deps(() => created());
    const result = await sendInquiry(request, [], undefined, d);
    expect(result.ok).toBe(true);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("/api/inquiries");
    const body = init.body as string;
    expect(JSON.parse(body)).toEqual({ ...request, photos: [] });
    expect(
      (init.headers as Record<string, string>)["x-amz-content-sha256"],
    ).toBe(await sha256Hex(body));
    expect(init.credentials).toBe("omit");
  });

  it("사진: 양식 받기 → 업로드 → 문의에 photoId·key", async () => {
    const { deps: d, fetch } = deps((url) => {
      if (url === "/api/inquiries/uploads")
        return json(200, {
          uploads: [
            {
              photoId: PHOTO_ID,
              key: KEY,
              url: "https://bucket.example/upload",
              fields: { key: KEY, policy: "p" },
              expiresAt: "2026-10-28T03:10:00Z",
            },
          ],
        });
      if (url.startsWith("https://"))
        return new Response(null, { status: 204 });
      return created([{ photoId: PHOTO_ID, status: "accepted" }]);
    });
    const progress = vi.fn();
    const blob = new Blob(["x"], { type: "image/jpeg" });
    const result = await sendInquiry(
      request,
      [{ blob, contentType: "image/jpeg" }],
      progress,
      d,
    );
    expect(result.ok).toBe(true);
    expect(JSON.parse(fetch.mock.calls[0]![1].body as string)).toEqual({
      photos: [{ contentType: "image/jpeg", size: 1 }],
    });
    const form = fetch.mock.calls[1]![1].body as FormData;
    expect([...form.keys()]).toEqual(["key", "policy", "file"]); // 파일은 맨 마지막
    expect(JSON.parse(fetch.mock.calls[2]![1].body as string).photos).toEqual([
      { photoId: PHOTO_ID, key: KEY },
    ]);
    expect(progress).toHaveBeenCalledWith({
      phase: "photos",
      done: 1,
      total: 1,
    });
  });

  it("양식 장수가 모자라거나 업로드가 실패하면 문의를 보내지 않음", async () => {
    const short = deps((url) =>
      url === "/api/inquiries/uploads" ? json(200, { uploads: [] }) : created(),
    );
    const blob = new Blob(["x"], { type: "image/jpeg" });
    expect(
      await sendInquiry(
        request,
        [{ blob, contentType: "image/jpeg" }],
        undefined,
        short.deps,
      ),
    ).toEqual({ ok: false, failure: "invalidResponse" });
    expect(short.fetch).toHaveBeenCalledTimes(1);
  });

  it("오류 응답·연결 없음·응답 없음을 이유별로 나눔", async () => {
    const cases: [Response | Error, string][] = [
      [
        json(429, { error: { code: "rate_limited", message: "m" } }),
        "rateLimited",
      ],
      [
        json(503, { error: { code: "service_unavailable", message: "m" } }),
        "unavailable",
      ],
      [
        json(400, { error: { code: "invalid_request", message: "m" } }),
        "rejected",
      ],
      [new Response("<html>", { status: 502 }), "unavailable"],
      [new TypeError("Failed to fetch"), "network"],
    ];
    for (const [answer, failure] of cases) {
      const { deps: d } = deps(() => {
        if (answer instanceof Error) throw answer;
        return answer;
      });
      expect(await sendInquiry(request, [], undefined, d)).toEqual({
        ok: false,
        failure,
      });
    }
    const offline = deps(() => created());
    offline.deps.online = () => false;
    expect(await sendInquiry(request, [], undefined, offline.deps)).toEqual({
      ok: false,
      failure: "offline",
    });
    expect(offline.fetch).not.toHaveBeenCalled();
  });

  it("성공 응답 모양이 계약과 다르면 접수로 보지 않음", async () => {
    const bad: unknown[] = [
      {},
      { inquiryId: "abc", receivedAt: "2026-10-28T03:00:00Z", photos: [] },
      { inquiryId: INQUIRY_ID, receivedAt: "어제", photos: [] },
      { inquiryId: INQUIRY_ID, receivedAt: "2026-10-28T03:00:00Z" },
      // 보내지 않은 사진 결과
      {
        inquiryId: INQUIRY_ID,
        receivedAt: "2026-10-28T03:00:00Z",
        photos: [{ photoId: PHOTO_ID, status: "accepted" }],
      },
    ];
    for (const body of bad) {
      const { deps: d } = deps(() => json(201, body));
      expect(await sendInquiry(request, [], undefined, d)).toEqual({
        ok: false,
        failure: "invalidResponse",
      });
    }
    const notJson = deps(() => new Response("ok", { status: 200 }));
    expect((await sendInquiry(request, [], undefined, notJson.deps)).ok).toBe(
      false,
    );
  });

  it("응답이 오지 않으면 시간 제한 뒤 network", async () => {
    vi.useFakeTimers();
    try {
      const { deps: d } = deps(
        (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener("abort", () =>
              reject(new Error("aborted")),
            );
          }),
      );
      d.digest = () => Promise.resolve("0".repeat(64)); // 타이머 시험이라 해시는 바로
      const pending = sendInquiry(request, [], undefined, d);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(await pending).toEqual({ ok: false, failure: "network" });
    } finally {
      vi.useRealTimers();
    }
  });
});
