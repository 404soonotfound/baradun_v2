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
});
