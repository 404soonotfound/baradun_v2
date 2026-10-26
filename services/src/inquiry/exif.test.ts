import { describe, expect, it } from "vitest";
import { inspectPhotoMetadata } from "./exif";

function tiff(gps: boolean): Buffer {
  const value = Buffer.alloc(gps ? 26 : 14);
  value.write("II", 0, "ascii");
  value.writeUInt16LE(42, 2);
  value.writeUInt32LE(8, 4);
  value.writeUInt16LE(gps ? 1 : 0, 8);
  if (gps) {
    value.writeUInt16LE(0x8825, 10);
    value.writeUInt16LE(4, 12);
    value.writeUInt32LE(1, 14);
    value.writeUInt32LE(20, 18);
  }
  return value;
}

// GPS 포인터가 IFD0이 아니라 썸네일 IFD(IFD1)에 있는 TIFF
function tiffGpsInSecondIfd(): Buffer {
  const value = Buffer.alloc(40);
  value.write("II", 0, "ascii");
  value.writeUInt16LE(42, 2);
  value.writeUInt32LE(8, 4); // IFD0 위치
  value.writeUInt16LE(0, 8); // IFD0: 항목 0개
  value.writeUInt32LE(14, 10); // 다음 IFD(IFD1) 위치
  value.writeUInt16LE(1, 14); // IFD1: 항목 1개
  value.writeUInt16LE(0x8825, 16); // GPS 포인터
  value.writeUInt16LE(4, 18);
  value.writeUInt32LE(1, 20);
  value.writeUInt32LE(34, 24);
  // IFD1 끝(28)의 다음 IFD 오프셋은 0(Buffer.alloc이 0으로 채움)
  return value;
}

// 다음 IFD 오프셋이 뒤로 가는(순환 가능성) TIFF
function tiffLoop(): Buffer {
  const value = Buffer.alloc(18);
  value.write("II", 0, "ascii");
  value.writeUInt16LE(42, 2);
  value.writeUInt32LE(8, 4);
  value.writeUInt16LE(0, 8); // IFD0: 항목 0개
  value.writeUInt32LE(8, 10); // 다음 IFD가 자기 자신을 가리킴
  return value;
}

function jpegFromTiff(payload: Buffer): Buffer {
  return jpegFromExif(
    Buffer.concat([Buffer.from("Exif\0\0", "binary"), payload]),
  );
}

function jpeg(gps: boolean): Buffer {
  const payload = Buffer.concat([Buffer.from("Exif\0\0", "binary"), tiff(gps)]);
  return jpegFromExif(payload);
}

function jpegFromExif(payload: Buffer): Buffer {
  const length = Buffer.alloc(2);
  length.writeUInt16BE(payload.length + 2);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe1]),
    length,
    payload,
    Buffer.from([0xff, 0xd9]),
  ]);
}

function png(gps: boolean): Buffer {
  const payload = tiff(gps);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(payload.length);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    length,
    Buffer.from("eXIf"),
    payload,
    Buffer.alloc(4),
  ]);
}

function webp(gps: boolean): Buffer {
  const payload = tiff(gps);
  const length = Buffer.alloc(4);
  length.writeUInt32LE(payload.length);
  const chunk = Buffer.concat([
    Buffer.from("EXIF"),
    length,
    payload,
    payload.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0),
  ]);
  const riffLength = Buffer.alloc(4);
  riffLength.writeUInt32LE(4 + chunk.length);
  return Buffer.concat([
    Buffer.from("RIFF"),
    riffLength,
    Buffer.from("WEBP"),
    chunk,
  ]);
}

describe("사진 EXIF 위치 정보 검사", () => {
  it.each([
    ["image/jpeg", jpeg(true)],
    ["image/png", png(true)],
    ["image/webp", webp(true)],
  ])("%s의 GPS IFD를 찾는다", (contentType, value) => {
    expect(inspectPhotoMetadata(contentType, value)).toBe("gps");
  });

  it("GPS가 없는 JPEG를 허용한다", () => {
    expect(inspectPhotoMetadata("image/jpeg", jpeg(false))).toBe("none");
  });

  it("GPS 포인터가 썸네일 IFD(IFD1)에 있어도 찾는다", () => {
    expect(
      inspectPhotoMetadata("image/jpeg", jpegFromTiff(tiffGpsInSecondIfd())),
    ).toBe("gps");
  });

  it("IFD 사슬이 뒤로 가면(순환 가능) 깨진 파일로 거부한다", () => {
    expect(inspectPhotoMetadata("image/jpeg", jpegFromTiff(tiffLoop()))).toBe(
      "invalid",
    );
  });

  it("깨진 사진을 거부한다", () => {
    expect(inspectPhotoMetadata("image/jpeg", Buffer.from("not-a-photo"))).toBe(
      "invalid",
    );
  });
});
