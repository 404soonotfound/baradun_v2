import type { CreateInquiryRequest } from "@baradun/contracts";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  handleInquiryHttp,
  requestFingerprint,
  type InquiryDependencies,
} from "./handler";
import type { InquiryReceipt, SaveResult, StoredInquiry } from "./store";

const KEY = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const PHOTO = {
  photoId: "0123456789abcdef",
  key: "pending/0123456789abcdef0123456789abcdef/0123456789abcdef",
};

function event(
  path: string,
  value: unknown,
  hash?: string,
): APIGatewayProxyEventV2 {
  const body = JSON.stringify(value);
  return {
    version: "2.0",
    routeKey: "$default",
    rawPath: path,
    rawQueryString: "",
    cookies: [],
    headers: {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(body)),
      "x-amz-content-sha256":
        hash ?? createHash("sha256").update(body).digest("hex"),
    },
    requestContext: {
      accountId: "anonymous",
      apiId: "function-url",
      domainName: "example.invalid",
      domainPrefix: "example",
      http: {
        method: "POST",
        path,
        protocol: "HTTP/2",
        sourceIp: "203.0.113.10",
        userAgent: "test",
      },
      requestId: "request",
      routeKey: "$default",
      stage: "$default",
      time: "26/Oct/2026:00:00:00 +0000",
      timeEpoch: 0,
    },
    body,
    isBase64Encoded: false,
  };
}

function dependencies(overrides: Partial<InquiryDependencies> = {}): InquiryDependencies {
  return {
    store: {
      allowRequest: vi.fn(async () => true),
      findReceipt: vi.fn(async () => undefined),
      save: vi.fn(async () => "saved" as const),
    },
    photos: {
      createUploads: vi.fn(async () => []),
      inspect: vi.fn(async (photo: { photoId: string }) => ({
        result: {
          photoId: photo.photoId,
          status: "rejected" as const,
          reason: "location_metadata" as const,
        },
      })),
    },
    notifier: { notify: vi.fn(async () => "sent" as const) },
    now: () => new Date("2026-10-26T00:00:00.000Z"),
    id: () => "123e4567-e89b-42d3-a456-426614174000",
    ...overrides,
  } as unknown as InquiryDependencies;
}

describe("문의 함수 URL 처리", () => {
  it("본문 해시가 다르면 Lambda에서 다시 거부한다", async () => {
    const deps = dependencies();
    const response = await handleInquiryHttp(
      event(
        "/api/inquiries",
        { idempotencyKey: KEY, type: "data_suggestion", message: "문의", photos: [] },
        "0".repeat(64),
      ),
      deps,
    );
    expect(response.statusCode).toBe(400);
    expect(deps.store.allowRequest).not.toHaveBeenCalled();
  });

  it("전역 분당 상한을 넘으면 429를 반환한다", async () => {
    const save = vi.fn();
    const deps = dependencies({
      store: {
        allowRequest: vi.fn(async () => false),
        findReceipt: vi.fn(async () => undefined),
        save,
      } as never,
    });
    const response = await handleInquiryHttp(
      event("/api/inquiries", {
        idempotencyKey: KEY,
        type: "data_suggestion",
        message: "문의",
        photos: [],
      }),
      deps,
    );
    expect(response.statusCode).toBe(429);
    expect(save).not.toHaveBeenCalled();
  });

  it("GPS 사진만 제외하고 문의를 접수한다", async () => {
    const deps = dependencies();
    const response = await handleInquiryHttp(
      event("/api/inquiries", {
        idempotencyKey: KEY,
        type: "data_error",
        message: " 관측값 문의 ",
        email: "reader@example.com",
        photos: [PHOTO],
      }),
      deps,
    );
    expect(response.statusCode).toBe(201);
    expect(deps.store.save).toHaveBeenCalledWith(
      expect.objectContaining({ message: "관측값 문의", photoKeys: [] }),
    );
    expect(JSON.parse(String(response.body)).photos).toEqual([
      {
        photoId: "0123456789abcdef",
        status: "rejected",
        reason: "location_metadata",
      },
    ]);
  });

  it("사진 검사 중 S3 오류는 거절로 바꾸지 않고 그대로 던짐(문의도 저장 안 됨)", async () => {
    // 던진 오류는 inquiryHandler의 바깥 catch가 503으로 바꿈
    const save = vi.fn(async () => "saved" as const);
    const deps = dependencies({
      store: {
        allowRequest: vi.fn(async () => true),
        findReceipt: vi.fn(async () => undefined),
        save,
      } as never,
      photos: {
        createUploads: vi.fn(async () => []),
        inspect: vi.fn(async () => {
          throw new Error("s3 장애(시험)");
        }),
      } as never,
    });
    await expect(
      handleInquiryHttp(
        event("/api/inquiries", {
          idempotencyKey: KEY,
          type: "data_error",
          message: "관측값 문의",
          photos: [PHOTO],
        }),
        deps,
      ),
    ).rejects.toThrow("s3 장애(시험)");
    expect(save).not.toHaveBeenCalled();
  });

  it("멱등 키가 없거나 UUID v4가 아니면 400(속도 제한도 세지 않음)", async () => {
    for (const idempotencyKey of [undefined, "not-a-uuid", KEY.toUpperCase()]) {
      const deps = dependencies();
      const response = await handleInquiryHttp(
        event("/api/inquiries", {
          ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
          type: "data_suggestion",
          message: "문의",
          photos: [],
        }),
        deps,
      );
      expect(response.statusCode, String(idempotencyKey)).toBe(400);
      expect(deps.store.allowRequest).not.toHaveBeenCalled();
      expect(deps.store.save).not.toHaveBeenCalled();
    }
  });
});

// 조건부 쓰기(attribute_not_exists)를 흉내 내는 메모리 저장소. 같은 키의 두 번째 save는 "duplicate"
function memoryStore(options: { rateLimit?: number } = {}) {
  const receipts = new Map<string, InquiryReceipt>();
  const inquiries: StoredInquiry[] = [];
  let charged = 0;
  const store = {
    receipts,
    inquiries,
    charged: () => charged,
    allowRequest: vi.fn(async () => {
      charged += 1;
      return charged <= (options.rateLimit ?? Infinity);
    }),
    findReceipt: vi.fn(async (key: string) => receipts.get(key)),
    save: vi.fn(async (inquiry: StoredInquiry): Promise<SaveResult> => {
      if (receipts.has(inquiry.idempotencyKey)) return "duplicate";
      receipts.set(inquiry.idempotencyKey, {
        fingerprint: inquiry.fingerprint,
        response: inquiry.response,
      });
      inquiries.push(inquiry);
      return "saved";
    }),
  };
  return store;
}

function sequentialIds() {
  let next = 0;
  return () =>
    `123e4567-e89b-42d3-a456-${String(426614174000 + next++).padStart(12, "0")}`;
}

const body = (overrides: Record<string, unknown> = {}) => ({
  idempotencyKey: KEY,
  type: "data_error",
  message: "관측값 문의",
  email: "reader@example.com",
  photos: [PHOTO],
  ...overrides,
});

describe("문의 멱등 키 (BRD-103)", () => {
  it("같은 키·같은 내용의 두 번째 요청은 새 문의·알림 없이 첫 응답을 그대로 돌려줌", async () => {
    const store = memoryStore();
    const deps = dependencies({ store: store as never, id: sequentialIds() });
    const first = await handleInquiryHttp(event("/api/inquiries", body()), deps);
    const second = await handleInquiryHttp(event("/api/inquiries", body()), deps);

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.body).toBe(first.body);
    expect(store.inquiries).toHaveLength(1);
    expect(deps.notifier.notify).toHaveBeenCalledTimes(1);
    expect(deps.photos.inspect).toHaveBeenCalledTimes(1);
  });

  it("이미 접수한 키의 재시도는 속도 제한을 다시 세지 않음(상한에 걸려도 첫 응답)", async () => {
    const store = memoryStore({ rateLimit: 1 });
    const deps = dependencies({ store: store as never, id: sequentialIds() });
    const first = await handleInquiryHttp(event("/api/inquiries", body()), deps);
    const retry = await handleInquiryHttp(event("/api/inquiries", body()), deps);
    const other = await handleInquiryHttp(
      event(
        "/api/inquiries",
        body({ idempotencyKey: "9b2d7a3e-1c4f-4e8a-b6d5-2f0e9c8a7b61" }),
      ),
      deps,
    );

    expect(retry.statusCode).toBe(201);
    expect(retry.body).toBe(first.body);
    expect(store.charged()).toBe(2); // 첫 요청 + 새 키 요청만 셈
    expect(other.statusCode).toBe(429); // 새 키는 그대로 제한
  });

  it("같은 키에 다른 내용이면 409 idempotency_conflict로 거부하고 새로 저장하지 않음", async () => {
    const store = memoryStore();
    const deps = dependencies({ store: store as never, id: sequentialIds() });
    await handleInquiryHttp(event("/api/inquiries", body()), deps);

    for (const changed of [
      { message: "다른 문의" },
      { type: "data_suggestion" },
      { email: "other@example.com" },
      { photos: [] },
    ]) {
      const response = await handleInquiryHttp(
        event("/api/inquiries", body(changed)),
        deps,
      );
      expect(response.statusCode, JSON.stringify(changed)).toBe(409);
      expect(JSON.parse(String(response.body)).error.code).toBe(
        "idempotency_conflict",
      );
    }
    expect(store.inquiries).toHaveLength(1);
    expect(deps.notifier.notify).toHaveBeenCalledTimes(1);
  });

  it("같은 키로 동시에 와도 문의·알림은 하나, 두 응답은 같음", async () => {
    const store = memoryStore();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const deps = dependencies({
      store: store as never,
      id: sequentialIds(),
      photos: {
        createUploads: vi.fn(async () => []),
        // 두 요청이 모두 멱등 기록 확인을 지난 뒤에 저장하게 붙잡아 둠
        inspect: vi.fn(async (photo: { photoId: string }) => {
          await gate;
          return { result: { photoId: photo.photoId, status: "accepted" as const } };
        }),
      } as never,
    });
    const both = Promise.all([
      handleInquiryHttp(event("/api/inquiries", body()), deps),
      handleInquiryHttp(event("/api/inquiries", body()), deps),
    ]);
    await vi.waitFor(() => expect(deps.photos.inspect).toHaveBeenCalledTimes(2));
    release();
    const [a, b] = await both;

    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect(a.body).toBe(b.body);
    expect(store.save).toHaveBeenCalledTimes(2);
    expect(store.inquiries).toHaveLength(1);
    expect(deps.notifier.notify).toHaveBeenCalledTimes(1);
  });

  it("조건부 쓰기에 졌는데 멱등 기록이 보이지 않으면 성공으로 꾸미지 않고 던짐(503)", async () => {
    const deps = dependencies({
      store: {
        allowRequest: vi.fn(async () => true),
        findReceipt: vi.fn(async () => undefined),
        save: vi.fn(async () => "duplicate" as const),
      } as never,
    });
    await expect(
      handleInquiryHttp(event("/api/inquiries", body()), deps),
    ).rejects.toThrow("멱등 기록");
    expect(deps.notifier.notify).not.toHaveBeenCalled();
  });

  it("멱등 기록 읽기 오류는 새 문의로 넘어가지 않고 던짐", async () => {
    const save = vi.fn();
    const deps = dependencies({
      store: {
        allowRequest: vi.fn(async () => true),
        findReceipt: vi.fn(async () => {
          throw new Error("dynamodb 장애(시험)");
        }),
        save,
      } as never,
    });
    await expect(
      handleInquiryHttp(event("/api/inquiries", body()), deps),
    ).rejects.toThrow("dynamodb 장애(시험)");
    expect(save).not.toHaveBeenCalled();
  });

  it("저장 뒤 알림이 던져도 접수는 201(재시도가 알림 없는 첫 결과만 받지 않게)", async () => {
    const store = memoryStore();
    const deps = dependencies({
      store: store as never,
      notifier: {
        notify: vi.fn(async () => {
          throw new Error("알림 카운터 장애(시험)");
        }),
      } as never,
    });
    const response = await handleInquiryHttp(event("/api/inquiries", body()), deps);
    expect(response.statusCode).toBe(201);
    expect(store.inquiries).toHaveLength(1);
  });

  it("내용 지문은 멱등 키를 빼고 유형·본문·이메일·사진마다 달라짐", () => {
    const base = body() as CreateInquiryRequest;
    const same = requestFingerprint({
      ...base,
      idempotencyKey: "9b2d7a3e-1c4f-4e8a-b6d5-2f0e9c8a7b61",
    });
    expect(same).toBe(requestFingerprint(base));
    expect(same).toMatch(/^[0-9a-f]{64}$/);
    const variants: CreateInquiryRequest[] = [
      { ...base, type: "data_suggestion" },
      { ...base, message: `${base.message} ` },
      { type: base.type, message: base.message, photos: base.photos, idempotencyKey: KEY }, // 이메일 없음
      { ...base, photos: [] },
      { ...base, photos: [{ ...PHOTO, photoId: "fedcba9876543210" }] },
    ];
    const prints = new Set(
      variants.map((variant) => requestFingerprint(variant)),
    );
    expect(prints.size).toBe(variants.length);
    expect(prints.has(same)).toBe(false);
  });
});

describe("사진 업로드 양식 발급 (BRD-103)", () => {
  const target = {
    photoId: "0123456789abcdef",
    key: PHOTO.key,
    method: "POST",
    url: "https://baradunv2-photos-test.s3.ap-northeast-2.amazonaws.com/",
    fields: {
      key: PHOTO.key,
      bucket: "baradunv2-photos-test",
      "Content-Type": "image/jpeg",
      Policy: "e30=",
      "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
      "X-Amz-Credential": "AKID/20261026/ap-northeast-2/s3/aws4_request",
      "X-Amz-Date": "20261026T000000Z",
      "X-Amz-Signature": "a".repeat(64),
    },
    expiresAt: "2026-10-26T00:10:00.000Z",
  };
  const request = { photos: [{ contentType: "image/jpeg", size: 10 }] };

  it("계약에 맞는 양식은 200으로 내보냄", async () => {
    const deps = dependencies({
      photos: { createUploads: vi.fn(async () => [target]) } as never,
    });
    const response = await handleInquiryHttp(
      event("/api/inquiries/uploads", request),
      deps,
    );
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(String(response.body))).toEqual({ uploads: [target] });
  });

  it("계약 밖 주소·칸이 나오면 내보내지 않고 던짐(503)", async () => {
    for (const bad of [
      { ...target, url: "https://evil.example/" },
      { ...target, url: "http://baradunv2-photos-test.s3.ap-northeast-2.amazonaws.com/" },
      { ...target, method: "PUT" },
      { ...target, fields: { ...target.fields, acl: "public-read" } },
    ]) {
      const deps = dependencies({
        photos: { createUploads: vi.fn(async () => [bad]) } as never,
      });
      await expect(
        handleInquiryHttp(event("/api/inquiries/uploads", request), deps),
        JSON.stringify(bad),
      ).rejects.toThrow("업로드 양식");
    }
  });

  it("모양이 틀린 양식 요청은 속도 제한을 세지 않고 400", async () => {
    const deps = dependencies();
    const response = await handleInquiryHttp(
      event("/api/inquiries/uploads", { photos: [] }),
      deps,
    );
    expect(response.statusCode).toBe(400);
    expect(deps.store.allowRequest).not.toHaveBeenCalled();
  });
});
