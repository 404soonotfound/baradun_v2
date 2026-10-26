import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  handleInquiryHttp,
  type InquiryDependencies,
} from "./handler";

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
      save: vi.fn(async () => undefined),
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
      event("/api/inquiries", { type: "other", message: "문의", photos: [] }, "0".repeat(64)),
      deps,
    );
    expect(response.statusCode).toBe(400);
    expect(deps.store.allowRequest).not.toHaveBeenCalled();
  });

  it("전역 분당 상한을 넘으면 429를 반환한다", async () => {
    const deps = dependencies({
      store: { allowRequest: vi.fn(async () => false) } as never,
    });
    const response = await handleInquiryHttp(
      event("/api/inquiries", { type: "other", message: "문의", photos: [] }),
      deps,
    );
    expect(response.statusCode).toBe(429);
  });

  it("GPS 사진만 제외하고 문의를 접수한다", async () => {
    const deps = dependencies();
    const response = await handleInquiryHttp(
      event("/api/inquiries", {
        type: "data_error",
        message: " 관측값 문의 ",
        email: "reader@example.com",
        photos: [
          {
            photoId: "0123456789abcdef",
            key: "pending/0123456789abcdef0123456789abcdef/0123456789abcdef",
          },
        ],
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
});
