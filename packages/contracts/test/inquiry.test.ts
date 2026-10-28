import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";

const schema = JSON.parse(
  readFileSync(
    new URL("../schemas/contract.schema.json", import.meta.url),
    "utf8",
  ),
);
const ajv = new Ajv2020({ allErrors: true, strictTypes: false });
addFormats(ajv);
ajv.addSchema(schema);

function validate(definition: string, value: unknown): boolean {
  const check = ajv.getSchema(`${schema.$id}#/$defs/${definition}`);
  if (!check) throw new Error(`계약 정의 없음: ${definition}`);
  return check(value) as boolean;
}

describe("데이터 문의 계약", () => {
  it("사진 3장과 5MiB 경계를 허용한다", () => {
    expect(
      validate("InquiryUploadRequest", {
        photos: Array.from({ length: 3 }, () => ({
          contentType: "image/jpeg",
          size: 5 * 1024 * 1024,
        })),
      }),
    ).toBe(true);
  });

  it("사진 4장이나 5MiB 초과를 거부한다", () => {
    expect(
      validate("InquiryUploadRequest", {
        photos: Array.from({ length: 4 }, () => ({
          contentType: "image/jpeg",
          size: 1,
        })),
      }),
    ).toBe(false);
    expect(
      validate("InquiryUploadRequest", {
        photos: [{ contentType: "image/jpeg", size: 5 * 1024 * 1024 + 1 }],
      }),
    ).toBe(false);
  });

  it("문의 본문·이메일·사진 참조 형식을 검사한다", () => {
    expect(
      validate("CreateInquiryRequest", {
        idempotencyKey: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
        type: "data_error",
        message: "관측값을 확인해 주세요.",
        email: "reader@example.com",
        photos: [
          {
            photoId: "0123456789abcdef",
            key: "pending/0123456789abcdef0123456789abcdef/0123456789abcdef",
          },
        ],
      }),
    ).toBe(true);
    expect(
      validate("CreateInquiryRequest", {
        type: "unknown",
        message: "문의",
        email: "not-an-email",
        photos: [],
      }),
    ).toBe(false);
  });

  it("응답은 처리 기한 필드를 허용하지 않는다", () => {
    const response = {
      inquiryId: "123e4567-e89b-42d3-a456-426614174000",
      receivedAt: "2026-10-26T00:00:00.000Z",
      photos: [],
    };
    expect(validate("CreateInquiryResponse", response)).toBe(true);
    expect(
      validate("CreateInquiryResponse", {
        ...response,
        responseDueAt: "2026-10-27T00:00:00.000Z",
      }),
    ).toBe(false);
  });

  it("문의 요청은 UUID v4 멱등 키가 꼭 있어야 한다", () => {
    const request = {
      idempotencyKey: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
      type: "other",
      message: "문의",
      photos: [],
    };
    expect(validate("CreateInquiryRequest", request)).toBe(true);
    const { idempotencyKey: _omit, ...withoutKey } = request;
    expect(validate("CreateInquiryRequest", withoutKey)).toBe(false);
    for (const idempotencyKey of [
      "",
      "not-a-uuid",
      "3F2504E0-4F89-41D3-9A0C-0305E82C3301", // 대문자
      "3f2504e0-4f89-11d3-9a0c-0305e82c3301", // v1
      "3f2504e0-4f89-41d3-7a0c-0305e82c3301", // 변형 자리 틀림
    ]) {
      expect(
        validate("CreateInquiryRequest", { ...request, idempotencyKey }),
        idempotencyKey,
      ).toBe(false);
    }
  });

  it("같은 키 다른 내용 거부 코드(idempotency_conflict)를 오류 응답에 둔다", () => {
    expect(
      validate("InquiryErrorResponse", {
        error: { code: "idempotency_conflict", message: "m" },
      }),
    ).toBe(true);
    expect(
      validate("InquiryErrorResponse", { error: { code: "conflict", message: "m" } }),
    ).toBe(false);
  });

  describe("사진 업로드 양식 (BRD-103)", () => {
    const KEY = "pending/0123456789abcdef0123456789abcdef/0123456789abcdef";
    const target = {
      photoId: "0123456789abcdef",
      key: KEY,
      method: "POST",
      url: "https://baradunv2-photos-test.s3.ap-northeast-2.amazonaws.com/",
      fields: {
        key: KEY,
        bucket: "baradunv2-photos-test",
        "Content-Type": "image/jpeg",
        Policy: "e30=",
        "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
        "X-Amz-Credential": "AKID/20261026/ap-northeast-2/s3/aws4_request",
        "X-Amz-Date": "20261026T000000Z",
        "X-Amz-Security-Token": "token",
        "X-Amz-Signature": "a".repeat(64),
      },
      expiresAt: "2026-10-26T00:10:00.000Z",
    };
    const withFields = (fields: Record<string, unknown>) => ({
      ...target,
      fields: { ...target.fields, ...fields },
    });

    it("서울 리전 버킷 가상 호스트의 / 와 정해진 칸만 허용한다", () => {
      expect(validate("InquiryUploadTarget", target)).toBe(true);
      const { "X-Amz-Security-Token": _token, ...noToken } = target.fields;
      expect(validate("InquiryUploadTarget", { ...target, fields: noToken })).toBe(
        true,
      );
    });

    it("다른 호스트·http·다른 경로·다른 리전·메서드를 거부한다", () => {
      for (const changed of [
        { url: "http://baradunv2-photos-test.s3.ap-northeast-2.amazonaws.com/" },
        { url: "https://evil.example/" },
        { url: "https://baradunv2-photos-test.s3.us-east-1.amazonaws.com/" },
        { url: "https://s3.ap-northeast-2.amazonaws.com/baradunv2-photos-test" },
        { url: "https://baradunv2-photos-test.s3.ap-northeast-2.amazonaws.com/upload" },
        { url: "https://baradunv2-photos-test.s3.ap-northeast-2.amazonaws.com/?x=1" },
        { url: "https://baradunv2-photos-test.s3.ap-northeast-2.amazonaws.com.evil.example/" },
        { method: "PUT" },
      ]) {
        expect(
          validate("InquiryUploadTarget", { ...target, ...changed }),
          JSON.stringify(changed),
        ).toBe(false);
      }
      const { method: _method, ...noMethod } = target;
      expect(validate("InquiryUploadTarget", noMethod)).toBe(false);
    });

    it("칸이 빠지거나 더 있거나, 키·콘텐츠 타입·알고리즘이 틀리면 거부한다", () => {
      for (const name of [
        "key",
        "bucket",
        "Content-Type",
        "Policy",
        "X-Amz-Algorithm",
        "X-Amz-Credential",
        "X-Amz-Date",
        "X-Amz-Signature",
      ]) {
        const fields: Record<string, unknown> = { ...target.fields };
        delete fields[name];
        expect(validate("InquiryUploadTarget", { ...target, fields }), name).toBe(
          false,
        );
      }
      for (const changed of [
        { acl: "public-read" },
        { success_action_redirect: "https://evil.example/" },
        { key: "accepted/0123456789abcdef0123456789abcdef/0123456789abcdef" },
        { "Content-Type": "image/gif" },
        { "Content-Type": "text/html" },
        { "X-Amz-Algorithm": "AWS4-HMAC-SHA1" },
        { bucket: "Bad_Bucket" },
        { "X-Amz-Signature": "zz" },
      ]) {
        expect(
          validate("InquiryUploadTarget", withFields(changed)),
          JSON.stringify(changed),
        ).toBe(false);
      }
    });
  });
});
