import { describe, expect, it, vi } from "vitest";

import {
  CLOCK_SKEW_MS,
  isUploadResponse,
  isUploadTarget,
  receiptUnknown,
  sendInquiry,
  sha256Hex,
  uploadUrlFor,
  type AttemptSlot,
  type SendDeps,
} from "./api";

// 데이터 문의 보내기 (BRD-37 · infra/README): 실제 서버로 보내지 않고 가짜 fetch로 확인

const PHOTO_ID = "0123456789abcdef";
const KEY = `pending/${"a".repeat(32)}/${PHOTO_ID}`;
const INQUIRY_ID = "123e4567-e89b-42d3-a456-426614174000";
const request = {
  type: "data_error" as const,
  message: "파고가 달라요",
};
const BUCKET = "baradunv2-photos-test";
const UPLOAD_URL = `https://${BUCKET}.s3.ap-northeast-2.amazonaws.com/`;
const NOW = Date.parse("2026-10-28T03:00:00Z");
const EXPIRES = "2026-10-28T03:10:00Z";
const UUID_A = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const UUID_B = "9b2d7a3e-1c4f-4e8a-b6d5-2f0e9c8a7b61";

// S3 presigned POST 정책(base64 JSON). services 시험의 실제 SDK 출력과 같은 모양
const policyFor = (
  key: string,
  contentType = "image/jpeg",
  over: Record<string, unknown> = {},
) =>
  btoa(
    JSON.stringify({
      expiration: EXPIRES,
      conditions: [
        ["eq", "$Content-Type", contentType],
        ["content-length-range", 1, 4 * 1024 * 1024],
        { "Content-Type": contentType },
        { bucket: BUCKET },
        { "X-Amz-Algorithm": "AWS4-HMAC-SHA256" },
        { key },
      ],
      ...over,
    }),
  );

const target = (photoId = PHOTO_ID, key = KEY, contentType = "image/jpeg") => ({
  photoId,
  key,
  method: "POST",
  url: UPLOAD_URL,
  fields: {
    "Content-Type": contentType,
    bucket: BUCKET,
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": "AKID/20261028/ap-northeast-2/s3/aws4_request",
    "X-Amz-Date": "20261028T030000Z",
    "X-Amz-Security-Token": "token",
    key,
    Policy: policyFor(key, contentType),
    "X-Amz-Signature": "a".repeat(64),
  } as Record<string, string>,
  expiresAt: EXPIRES,
});
const jpeg = (text = "x") => ({
  blob: new Blob([text], { type: "image/jpeg" }),
  contentType: "image/jpeg" as const,
});

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
    now: () => NOW,
    uuid: vi.fn(() => UUID_A),
    photoBucket: BUCKET,
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
    expect(JSON.parse(body)).toEqual({
      ...request,
      idempotencyKey: UUID_A,
      photos: [],
    });
    expect(
      (init.headers as Record<string, string>)["x-amz-content-sha256"],
    ).toBe(await sha256Hex(body));
    expect(init.credentials).toBe("omit");
  });

  it("사진: 양식 받기 → 업로드 → 문의에 photoId·key", async () => {
    const { deps: d, fetch } = deps((url) => {
      if (url === "/api/inquiries/uploads")
        return json(200, { uploads: [target()] });
      if (url === UPLOAD_URL)
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
    expect(fetch.mock.calls[1]![0]).toBe(UPLOAD_URL);
    expect(fetch.mock.calls[1]![1].method).toBe("POST");
    expect([...form.keys()]).toEqual([...Object.keys(target().fields), "file"]); // 파일은 맨 마지막
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
    ).toEqual({
      ok: false,
      failure: "invalidResponse",
      stop: { stage: "photos", uploaded: 0, total: 1 },
    });
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
        stop: { stage: "message", photos: 0 },
      });
    }
    const offline = deps(() => created());
    offline.deps.online = () => false;
    expect(await sendInquiry(request, [], undefined, offline.deps)).toEqual({
      ok: false,
      failure: "offline",
      stop: { stage: "message", photos: 0 },
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
        stop: { stage: "message", photos: 0 },
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
      expect(await pending).toEqual({
        ok: false,
        failure: "network",
        stop: { stage: "message", photos: 0 },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("보낸 사진마다 결과가 하나씩 오지 않으면(빠짐·겹침) 접수로 보지 않음", async () => {
    const OTHER_ID = "fedcba9876543210";
    const OTHER_KEY = `pending/${"b".repeat(32)}/${OTHER_ID}`;
    const blob = new Blob(["x"], { type: "image/jpeg" });
    const photos = [
      { blob, contentType: "image/jpeg" as const },
      { blob, contentType: "image/jpeg" as const },
    ];
    for (const results of [
      [{ photoId: PHOTO_ID, status: "accepted" }],
      [
        { photoId: PHOTO_ID, status: "accepted" },
        { photoId: PHOTO_ID, status: "accepted" },
      ],
      [],
    ]) {
      const { deps: d } = deps((url) => {
        if (url === "/api/inquiries/uploads")
          return json(200, {
            uploads: [target(PHOTO_ID, KEY), target(OTHER_ID, OTHER_KEY)],
          });
        if (url === UPLOAD_URL) return new Response(null, { status: 204 });
        return created(results);
      });
      expect(
        await sendInquiry(request, photos, undefined, d),
        JSON.stringify(results),
      ).toEqual({
        ok: false,
        failure: "invalidResponse",
        stop: { stage: "message", photos: 2 },
      });
    }
  });

  it("응답 헤더 뒤 본문이 멈춰도 시간 제한 뒤 network('보내는 중'에 멈추지 않음)", async () => {
    vi.useFakeTimers();
    try {
      const { deps: d } = deps(
        () =>
          new Response(
            new ReadableStream({
              start() {
                // 본문을 보내지 않고 끝내지도 않음
              },
            }),
            { status: 201 },
          ),
      );
      d.digest = () => Promise.resolve("0".repeat(64));
      const pending = sendInquiry(request, [], undefined, d);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(await pending).toEqual({
        ok: false,
        failure: "network",
        stop: { stage: "message", photos: 0 },
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("업로드 양식 검사 (결정 26)", () => {
  const photo = { contentType: "image/jpeg" };
  const check = (item: unknown, now = NOW, bucket = BUCKET) =>
    isUploadTarget(item, photo, now, bucket);
  const withFields = (fields: Record<string, string | undefined>) => {
    const item = target();
    const merged: Record<string, unknown> = { ...item.fields, ...fields };
    for (const [name, value] of Object.entries(merged))
      if (value === undefined) delete merged[name];
    return { ...item, fields: merged };
  };

  it("허용 버킷 주소는 서울 리전 가상 호스트의 / 하나. 버킷 설정이 비거나 틀리면 아무 주소도 허용 안 함", () => {
    expect(uploadUrlFor(BUCKET)).toBe(UPLOAD_URL);
    for (const bucket of ["", "a", "Bad_Bucket", "with.dot.bucket", "-start", "end-"])
      expect(uploadUrlFor(bucket), bucket).toBeNull();
    expect(check(target())).toBe(true);
    expect(check(target(), NOW, "")).toBe(false);
    expect(check(target(), NOW, "baradunv2-other")).toBe(false);
  });

  it("다른 호스트·http·다른 경로·질의·포트·사용자 정보·다른 리전이면 거부", () => {
    for (const url of [
      "https://evil.example/",
      `http://${BUCKET}.s3.ap-northeast-2.amazonaws.com/`,
      `https://${BUCKET}.s3.ap-northeast-2.amazonaws.com/upload`,
      `https://${BUCKET}.s3.ap-northeast-2.amazonaws.com`,
      `https://${BUCKET}.s3.ap-northeast-2.amazonaws.com/?x=1`,
      `https://${BUCKET}.s3.ap-northeast-2.amazonaws.com/#x`,
      `https://${BUCKET}.s3.ap-northeast-2.amazonaws.com:8443/`,
      `https://user@${BUCKET}.s3.ap-northeast-2.amazonaws.com/`,
      `https://${BUCKET}.s3.us-east-1.amazonaws.com/`,
      `https://${BUCKET}.s3.ap-northeast-2.amazonaws.com.evil.example/`,
      `https://other-bucket.s3.ap-northeast-2.amazonaws.com/`,
      `https://s3.ap-northeast-2.amazonaws.com/${BUCKET}`,
      `HTTPS://${BUCKET.toUpperCase()}.S3.AP-NORTHEAST-2.AMAZONAWS.COM/`,
    ])
      expect(check({ ...target(), url }), url).toBe(false);
  });

  it("메서드가 POST가 아니거나 없으면 거부", () => {
    for (const method of ["PUT", "post", undefined])
      expect(check({ ...target(), method }), String(method)).toBe(false);
  });

  it("지난 만료·지금 만료·10분 + 시계 차이보다 먼 만료·날짜가 아닌 값은 거부", () => {
    const at = (ms: number) => new Date(ms).toISOString();
    expect(check(target(), NOW)).toBe(true);
    // 기기 시계가 늦어 만료가 10분보다 조금 멀어 보이는 것은 허용
    expect(check(target(), Date.parse(EXPIRES) - 10 * 60_000 - CLOCK_SKEW_MS)).toBe(true);
    expect(check(target(), Date.parse(EXPIRES))).toBe(false); // 지금 만료
    expect(check(target(), Date.parse(EXPIRES) + 1)).toBe(false); // 지남
    expect(
      check(target(), Date.parse(EXPIRES) - 10 * 60_000 - CLOCK_SKEW_MS - 1),
    ).toBe(false); // 너무 멂
    for (const expiresAt of [at(NOW + 7 * 86_400_000), "내일", "", undefined])
      expect(check({ ...target(), expiresAt }), String(expiresAt)).toBe(false);
  });

  it("S3 정책의 만료가 지났거나 너무 멀면 거부(양식 expiresAt만 믿지 않음)", () => {
    for (const expiration of [
      "2026-10-28T02:59:59Z",
      "2026-11-04T03:00:00Z",
      "someday",
      undefined,
    ])
      expect(
        check(withFields({ Policy: policyFor(KEY, "image/jpeg", { expiration }) })),
        String(expiration),
      ).toBe(false);
  });

  it("콘텐츠 타입이 이 사진과 다르거나 허용 이미지가 아니면 거부", () => {
    expect(check(withFields({ "Content-Type": "image/png" }))).toBe(false);
    expect(
      isUploadTarget(target(PHOTO_ID, KEY, "image/png"), { contentType: "image/jpeg" }, NOW, BUCKET),
    ).toBe(false);
    expect(
      isUploadTarget(target(PHOTO_ID, KEY, "image/gif"), { contentType: "image/gif" }, NOW, BUCKET),
    ).toBe(false);
    expect(
      isUploadTarget(target(PHOTO_ID, KEY, "image/png"), { contentType: "image/png" }, NOW, BUCKET),
    ).toBe(true);
    // 정책이 다른 타입을 강제하면 거부
    expect(check(withFields({ Policy: policyFor(KEY, "image/png") }))).toBe(false);
  });

  it("키가 pending/ 형식이 아니거나 칸의 키·버킷이 다르면 거부", () => {
    const accepted = `accepted/${"a".repeat(32)}/${PHOTO_ID}`;
    expect(check(target(PHOTO_ID, accepted))).toBe(false);
    expect(check({ ...target(), key: `pending/${"b".repeat(32)}/${PHOTO_ID}` })).toBe(false);
    expect(check(withFields({ key: `pending/${"b".repeat(32)}/${PHOTO_ID}` }))).toBe(false);
    expect(check(withFields({ bucket: "baradunv2-other" }))).toBe(false);
    expect(check({ ...target(), photoId: "xyz" })).toBe(false);
    // 정책의 키·버킷이 칸과 다르면 거부
    expect(
      check(
        withFields({
          Policy: policyFor(KEY, "image/jpeg", {
            conditions: [
              ["eq", "$Content-Type", "image/jpeg"],
              { bucket: BUCKET },
              { key: `pending/${"b".repeat(32)}/${PHOTO_ID}` },
            ],
          }),
        }),
      ),
    ).toBe(false);
    expect(
      check(
        withFields({
          Policy: policyFor(KEY, "image/jpeg", {
            conditions: [["eq", "$Content-Type", "image/jpeg"], { key: KEY }],
          }),
        }),
      ),
    ).toBe(false);
  });

  it("필수 칸이 빠지거나 정해지지 않은 칸이 있거나 정책을 읽을 수 없으면 거부", () => {
    for (const name of [
      "key",
      "bucket",
      "Content-Type",
      "Policy",
      "X-Amz-Algorithm",
      "X-Amz-Credential",
      "X-Amz-Date",
      "X-Amz-Signature",
    ])
      expect(check(withFields({ [name]: undefined })), name).toBe(false);
    expect(check(withFields({ "X-Amz-Security-Token": undefined }))).toBe(true);
    for (const extra of [
      { acl: "public-read" },
      { success_action_redirect: "https://evil.example/" },
      { "X-Amz-Algorithm": "AWS4-HMAC-SHA1" },
      { Policy: "이건 base64가 아님" },
      { Policy: btoa("[]") },
      { Policy: btoa("{}") },
    ])
      expect(check(withFields(extra)), JSON.stringify(extra)).toBe(false);
    expect(check({ ...target(), fields: { ...target().fields, key: 1 } })).toBe(false);
    expect(check({ ...target(), fields: null })).toBe(false);
    expect(check(null)).toBe(false);
  });

  it("묶음: 장수가 다르거나 키가 겹치거나 하나라도 틀리면 전체 거부", () => {
    const OTHER_ID = "fedcba9876543210";
    const OTHER_KEY = `pending/${"b".repeat(32)}/${OTHER_ID}`;
    const two = [photo, photo];
    expect(
      isUploadResponse({ uploads: [target(), target(OTHER_ID, OTHER_KEY)] }, two, NOW, BUCKET),
    ).toBe(true);
    expect(isUploadResponse({ uploads: [target()] }, two, NOW, BUCKET)).toBe(false);
    expect(isUploadResponse({ uploads: [target(), target()] }, two, NOW, BUCKET)).toBe(false);
    expect(
      isUploadResponse(
        { uploads: [target(), { ...target(OTHER_ID, OTHER_KEY), url: "https://evil.example/" }] },
        two,
        NOW,
        BUCKET,
      ),
    ).toBe(false);
    expect(isUploadResponse({}, two, NOW, BUCKET)).toBe(false);
  });

  it("양식이 틀리면 사진을 올리지 않고 문의도 보내지 않음(invalidResponse)", async () => {
    for (const bad of [
      { ...target(), url: "https://evil.example/" },
      { ...target(), url: `http://${BUCKET}.s3.ap-northeast-2.amazonaws.com/` },
      { ...target(), expiresAt: "2026-10-28T02:00:00Z" },
      { ...target(), method: "PUT" },
    ]) {
      const { deps: d, fetch } = deps((url) =>
        url === "/api/inquiries/uploads" ? json(200, { uploads: [bad] }) : created(),
      );
      expect(await sendInquiry(request, [jpeg()], undefined, d)).toEqual({
        ok: false,
        failure: "invalidResponse",
        stop: { stage: "photos", uploaded: 0, total: 1 },
      });
      expect(fetch).toHaveBeenCalledTimes(1); // 양식 요청만
    }
  });

  it("앞 사진을 올리는 사이 다음 양식이 만료되면 그 사진을 올리지 않고 멈춤", async () => {
    const OTHER_ID = "fedcba9876543210";
    const OTHER_KEY = `pending/${"b".repeat(32)}/${OTHER_ID}`;
    let now = NOW;
    const { deps: d, fetch } = deps((url) => {
      if (url === "/api/inquiries/uploads")
        return json(200, { uploads: [target(), target(OTHER_ID, OTHER_KEY)] });
      if (url === UPLOAD_URL) {
        now = Date.parse(EXPIRES); // 첫 업로드가 끝나니 만료 시각
        return new Response(null, { status: 204 });
      }
      return created();
    });
    d.now = () => now;
    expect(await sendInquiry(request, [jpeg("a"), jpeg("b")], undefined, d)).toEqual({
      ok: false,
      failure: "invalidResponse",
      stop: { stage: "photos", uploaded: 1, total: 2 }, // 첫 장은 올라감(결정 27)
    });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "/api/inquiries/uploads",
      UPLOAD_URL,
    ]);
  });
});

describe("멱등 키 (결정 24)", () => {
  const bodyOf = (call: [string, RequestInit]) =>
    JSON.parse(call[1].body as string) as Record<string, unknown>;
  const inquiryCalls = (fetch: ReturnType<typeof deps>["fetch"]) =>
    fetch.mock.calls.filter(([url]) => url === "/api/inquiries");

  it("응답을 못 받고 같은 내용으로 다시 보내면 같은 키·같은 사진 참조(사진은 다시 올리지 않음)", async () => {
    let answer: "drop" | "ok" = "drop";
    const { deps: d, fetch } = deps((url) => {
      if (url === "/api/inquiries/uploads") return json(200, { uploads: [target()] });
      if (url === UPLOAD_URL) return new Response(null, { status: 204 });
      if (answer === "drop") throw new TypeError("Failed to fetch");
      return created([{ photoId: PHOTO_ID, status: "accepted" }]);
    });
    const attempt: AttemptSlot = { current: null };
    expect(await sendInquiry(request, [jpeg()], undefined, d, attempt)).toEqual({
      ok: false,
      failure: "network",
      stop: { stage: "message", photos: 1 },
    });
    expect(attempt.current?.idempotencyKey).toBe(UUID_A);
    expect(attempt.current?.refs).toEqual([{ photoId: PHOTO_ID, key: KEY }]);

    answer = "ok";
    // 실패 뒤 사진을 다시 넣으면 새 Blob이지만 내용이 같음
    const retry = await sendInquiry(request, [jpeg()], undefined, d, attempt);
    expect(retry.ok).toBe(true);
    const calls = inquiryCalls(fetch);
    expect(calls).toHaveLength(2);
    expect(bodyOf(calls[1]!)).toEqual(bodyOf(calls[0]!)); // 본문이 같음 → 서버가 첫 결과를 줌
    expect(bodyOf(calls[1]!).idempotencyKey).toBe(UUID_A);
    expect(
      fetch.mock.calls.filter(([url]) => url === "/api/inquiries/uploads"),
    ).toHaveLength(1);
    expect(d.uuid).toHaveBeenCalledTimes(1);
    expect(attempt.current).toBeNull(); // 접수 → 비움
  });

  it("접수된 뒤 다음 문의는 새 키", async () => {
    const { deps: d, fetch } = deps(() => created());
    const uuid = vi.fn().mockReturnValueOnce(UUID_A).mockReturnValueOnce(UUID_B);
    d.uuid = uuid;
    const attempt: AttemptSlot = { current: null };
    await sendInquiry(request, [], undefined, d, attempt);
    await sendInquiry(request, [], undefined, d, attempt);
    expect(inquiryCalls(fetch).map((call) => bodyOf(call).idempotencyKey)).toEqual([
      UUID_A,
      UUID_B,
    ]);
  });

  it("내용(유형·본문·이메일·사진)이 바뀌면 새 키", async () => {
    const changes: [typeof request & { email?: string }, ReturnType<typeof jpeg>[]][] = [
      [{ ...request, message: `${request.message}!` }, []],
      [{ ...request, type: "other" as never }, []],
      [{ ...request, email: "reader@example.com" }, []],
      [request, [jpeg("다른 사진")]],
    ];
    for (const [changed, photos] of changes) {
      const { deps: d } = deps((url) => {
        if (url === "/api/inquiries/uploads") return json(200, { uploads: [target()] });
        if (url === UPLOAD_URL) return new Response(null, { status: 204 });
        throw new TypeError("Failed to fetch");
      });
      d.uuid = vi.fn().mockReturnValueOnce(UUID_A).mockReturnValueOnce(UUID_B);
      const attempt: AttemptSlot = { current: null };
      await sendInquiry(request, [], undefined, d, attempt);
      await sendInquiry(changed, photos, undefined, d, attempt);
      expect(attempt.current?.idempotencyKey, JSON.stringify(changed)).toBe(UUID_B);
    }
  });

  it("거부(400·409)되면 다음 시도는 새 키", async () => {
    for (const answer of [
      json(409, { error: { code: "idempotency_conflict", message: "m" } }),
      json(400, { error: { code: "invalid_request", message: "m" } }),
    ]) {
      const { deps: d } = deps(() => answer.clone());
      const attempt: AttemptSlot = { current: null };
      expect(await sendInquiry(request, [], undefined, d, attempt)).toEqual({
        ok: false,
        failure: "rejected",
        stop: { stage: "message", photos: 0 },
      });
      expect(attempt.current).toBeNull();
    }
  });

  it("사진 업로드가 중간에 실패하면 키는 유지하되 참조가 없어 다시 올림", async () => {
    let s3 = 503;
    const { deps: d, fetch } = deps((url) => {
      if (url === "/api/inquiries/uploads") return json(200, { uploads: [target()] });
      if (url === UPLOAD_URL) return new Response(null, { status: s3 });
      return created([{ photoId: PHOTO_ID, status: "accepted" }]);
    });
    const attempt: AttemptSlot = { current: null };
    expect((await sendInquiry(request, [jpeg()], undefined, d, attempt)).ok).toBe(false);
    expect(attempt.current).toMatchObject({ idempotencyKey: UUID_A, refs: null });
    s3 = 204;
    expect((await sendInquiry(request, [jpeg()], undefined, d, attempt)).ok).toBe(true);
    expect(
      fetch.mock.calls.filter(([url]) => url === "/api/inquiries/uploads"),
    ).toHaveLength(2);
    expect(bodyOf(inquiryCalls(fetch)[0]!).idempotencyKey).toBe(UUID_A);
  });

  it("시도 기록에는 이메일 원문을 남기지 않음(지문만)", async () => {
    const { deps: d } = deps(() => {
      throw new TypeError("Failed to fetch");
    });
    const attempt: AttemptSlot = { current: null };
    await sendInquiry({ ...request, email: "reader@example.com" }, [], undefined, d, attempt);
    expect(JSON.stringify(attempt.current)).not.toContain("reader@example.com");
    expect(attempt.current?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("멈춘 단계와 접수 여부 (결정 27)", () => {
  it("사진 업로드가 중간에 실패하면 올라간 장수와 함께 사진 단계로 알림", async () => {
    const OTHER_ID = "fedcba9876543210";
    const OTHER_KEY = `pending/${"b".repeat(32)}/${OTHER_ID}`;
    let uploads = 0;
    const { deps: d, fetch } = deps((url) => {
      if (url === "/api/inquiries/uploads")
        return json(200, { uploads: [target(), target(OTHER_ID, OTHER_KEY)] });
      if (url === UPLOAD_URL)
        return new Response(null, { status: ++uploads === 1 ? 204 : 503 });
      return created();
    });
    const result = await sendInquiry(request, [jpeg("a"), jpeg("b")], undefined, d);
    expect(result).toEqual({
      ok: false,
      failure: "unavailable",
      stop: { stage: "photos", uploaded: 1, total: 2 },
    });
    expect(receiptUnknown(result as never)).toBe(false); // 문의는 보내지 않음
    expect(fetch.mock.calls.some(([url]) => url === "/api/inquiries")).toBe(false);
  });

  it("접수 여부를 모르는 시도 뒤 재시도가 429면 앞 시도의 접수 여부를 모르는 채로 둠(Codex P2)", async () => {
    let answer: "drop" | "limited" = "drop";
    const { deps: d } = deps(() => {
      if (answer === "drop") throw new TypeError("Failed to fetch");
      return json(429, { error: { code: "rate_limited", message: "m" } });
    });
    const attempt: AttemptSlot = { current: null };
    await sendInquiry(request, [], undefined, d, attempt);
    answer = "limited";
    const retry = await sendInquiry(request, [], undefined, d, attempt);
    expect(retry).toEqual({
      ok: false,
      failure: "rateLimited",
      stop: { stage: "message", photos: 0, uncertain: true },
    });
    expect(retry.ok === false && receiptUnknown(retry)).toBe(true);
    expect(attempt.current?.uncertain).toBe(true); // 다음 재시도도 같은 키·같은 상태
  });

  it("접수 여부를 모르는 시도 뒤 재시도가 400이면 접수 안 됨으로 알리고 새 키를 씀", async () => {
    let answer: "drop" | "invalid" = "drop";
    const { deps: d } = deps(() => {
      if (answer === "drop") throw new TypeError("Failed to fetch");
      return json(400, { error: { code: "invalid_request", message: "m" } });
    });
    const attempt: AttemptSlot = { current: null };
    await sendInquiry(request, [], undefined, d, attempt);
    answer = "invalid";
    const retry = await sendInquiry(request, [], undefined, d, attempt);
    expect(retry).toEqual({
      ok: false,
      failure: "rejected",
      stop: { stage: "message", photos: 0 },
    });
    expect(attempt.current).toBeNull();
  });

  it("처음부터 429면 접수되지 않았다고 알림", async () => {
    const { deps: d } = deps(() =>
      json(429, { error: { code: "rate_limited", message: "m" } }),
    );
    const result = await sendInquiry(request, [], undefined, d);
    expect(result.ok === false && receiptUnknown(result)).toBe(false);
  });

  it("접수 여부를 모르는 시도 뒤 연결 없이 다시 보내면 여전히 접수 여부를 모른다고 알림", async () => {
    const { deps: d } = deps(() => {
      throw new TypeError("Failed to fetch");
    });
    const attempt: AttemptSlot = { current: null };
    const first = await sendInquiry(request, [], undefined, d, attempt);
    expect(first.ok === false && receiptUnknown(first)).toBe(true);
    d.online = () => false;
    const offline = await sendInquiry(request, [], undefined, d, attempt);
    expect(offline).toEqual({
      ok: false,
      failure: "offline",
      stop: { stage: "message", photos: 0, uncertain: true },
    });
    expect(offline.ok === false && receiptUnknown(offline)).toBe(true);
    // 내용이 바뀌면 다른 문의라 앞 시도와 묶지 않음
    const changed = await sendInquiry(
      { ...request, message: "다른 내용이에요" },
      [],
      undefined,
      d,
      attempt,
    );
    expect(changed.ok === false && receiptUnknown(changed)).toBe(false);
  });

  it("연결 없이 사진과 보내면 사진 0장 단계로 멈춤", async () => {
    const offline = deps(() => created());
    offline.deps.online = () => false;
    expect(
      await sendInquiry(request, [jpeg()], undefined, offline.deps),
    ).toEqual({
      ok: false,
      failure: "offline",
      stop: { stage: "photos", uploaded: 0, total: 1 },
    });
  });

  it("문의 요청 뒤 응답을 못 받았거나 5xx·모양 틀림이면 접수 여부를 모름, 거절이면 접수 안 됨", () => {
    const message = { stage: "message", photos: 0 } as const;
    for (const failure of ["network", "unavailable", "invalidResponse"] as const)
      expect(receiptUnknown({ failure, stop: message }), failure).toBe(true);
    for (const failure of ["offline", "rateLimited", "rejected"] as const)
      expect(receiptUnknown({ failure, stop: message }), failure).toBe(false);
    expect(
      receiptUnknown({
        failure: "network",
        stop: { stage: "photos", uploaded: 1, total: 2 },
      }),
    ).toBe(false);
  });

  it("해변·활동은 요청 본문에 칸으로 들어가고, 바뀌면 새 멱등 키", async () => {
    const { deps: d, fetch } = deps(() => {
      throw new TypeError("Failed to fetch");
    });
    d.uuid = vi.fn().mockReturnValueOnce(UUID_A).mockReturnValueOnce(UUID_B);
    const attempt: AttemptSlot = { current: null };
    const withBeach = { ...request, beachId: "b0001", activity: "surfing" as const };
    await sendInquiry(withBeach, [], undefined, d, attempt);
    const first = JSON.parse(fetch.mock.calls[0]![1].body as string);
    expect(first).toMatchObject({ beachId: "b0001", activity: "surfing" });
    expect(attempt.current?.idempotencyKey).toBe(UUID_A);
    await sendInquiry({ ...withBeach, activity: "scuba" }, [], undefined, d, attempt);
    expect(attempt.current?.idempotencyKey).toBe(UUID_B);
  });
});
