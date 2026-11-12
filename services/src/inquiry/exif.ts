export type PhotoMetadataInspection = "none" | "gps" | "invalid";

const JPEG_START = Buffer.from([0xff, 0xd8]);
const PNG_START = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const EXIF_PREFIX = Buffer.from("Exif\0\0", "binary");

function tiffPayload(value: Buffer): Buffer {
  return value.subarray(0, EXIF_PREFIX.length).equals(EXIF_PREFIX)
    ? value.subarray(EXIF_PREFIX.length)
    : value;
}

function inspectTiff(value: Buffer): PhotoMetadataInspection {
  if (value.length < 8) return "invalid";
  const marker = value.toString("ascii", 0, 2);
  const littleEndian = marker === "II";
  if (!littleEndian && marker !== "MM") return "invalid";

  const read16 = (offset: number): number | undefined => {
    if (offset < 0 || offset + 2 > value.length) return undefined;
    return littleEndian ? value.readUInt16LE(offset) : value.readUInt16BE(offset);
  };
  const read32 = (offset: number): number | undefined => {
    if (offset < 0 || offset + 4 > value.length) return undefined;
    return littleEndian ? value.readUInt32LE(offset) : value.readUInt32BE(offset);
  };

  if (read16(2) !== 42) return "invalid";
  let ifdOffset = read32(4);
  if (ifdOffset === undefined) return "invalid";

  // GPS 포인터(0x8825)는 IFD0이 보통이지만 썸네일 IFD(IFD1)에도 올 수 있음 → 사슬 전체를 봄
  // 사슬 횟수 제한과 "오프셋은 앞으로만" 규칙으로 비정상 파일의 순환을 막음
  for (let chain = 0; chain < 8; chain += 1) {
    if (ifdOffset === 0) return "none"; // 사슬 끝
    const count = read16(ifdOffset);
    if (count === undefined || count > 4096) return "invalid";

    const end = ifdOffset + 2 + count * 12;
    // IFD 끝에는 다음 IFD 오프셋 4바이트가 있어야 함(TIFF 구조). 없으면 깨진 파일로 봄
    if (end + 4 > value.length) return "invalid";
    for (let index = 0; index < count; index += 1) {
      const entry = ifdOffset + 2 + index * 12;
      if (read16(entry) === 0x8825) return "gps";
    }
    const next = read32(end);
    if (next === undefined || (next !== 0 && next <= ifdOffset)) {
      return "invalid";
    }
    ifdOffset = next;
  }
  return "invalid"; // 사슬이 비정상적으로 긺
}

function inspectJpeg(value: Buffer): PhotoMetadataInspection {
  if (!value.subarray(0, 2).equals(JPEG_START)) return "invalid";
  let offset = 2;
  while (offset < value.length) {
    if (value[offset] !== 0xff) return "invalid";
    while (value[offset] === 0xff) offset += 1;
    if (offset >= value.length) return "invalid";
    const marker = value[offset];
    offset += 1;
    if (marker === 0xd9) return offset === value.length ? "none" : "invalid";
    if (marker === 0x01 || (marker !== undefined && marker >= 0xd0 && marker <= 0xd7)) {
      continue;
    }
    if (offset + 2 > value.length) return "invalid";
    const length = value.readUInt16BE(offset);
    if (length < 2 || offset + length > value.length) return "invalid";
    const payload = value.subarray(offset + 2, offset + length);
    if (marker === 0xe1 && payload.subarray(0, 6).equals(EXIF_PREFIX)) {
      const exif = inspectTiff(payload.subarray(6));
      if (exif !== "none") return exif;
    }
    offset += length;
    // SOS(0xda) 뒤 압축 스캔 구간을 지나 다음 마커(재시작·다중 스캔·EOI)까지 진행함
    if (marker === 0xda) {
      while (offset < value.length) {
        if (value[offset] !== 0xff) {
          offset += 1;
          continue;
        }
        while (value[offset] === 0xff) offset += 1;
        if (offset >= value.length) return "invalid";
        const next = value[offset];
        if (next === 0x00 || (next !== undefined && next >= 0xd0 && next <= 0xd7)) {
          offset += 1;
          continue;
        }
        offset -= 1;
        break;
      }
    }
  }
  return "invalid";
}

function inspectPng(value: Buffer): PhotoMetadataInspection {
  if (!value.subarray(0, PNG_START.length).equals(PNG_START)) return "invalid";
  let offset = PNG_START.length;
  while (offset + 12 <= value.length) {
    const length = value.readUInt32BE(offset);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > value.length) return "invalid";
    const type = value.toString("ascii", offset + 4, offset + 8);
    if (type === "eXIf") {
      const exif = inspectTiff(tiffPayload(value.subarray(dataStart, dataEnd)));
      if (exif !== "none") return exif;
    }
    if (type === "IEND") {
      return length === 0 && dataEnd + 4 === value.length ? "none" : "invalid";
    }
    offset = dataEnd + 4;
  }
  return "invalid";
}

function inspectWebp(value: Buffer): PhotoMetadataInspection {
  if (
    value.length < 12 ||
    value.toString("ascii", 0, 4) !== "RIFF" ||
    value.toString("ascii", 8, 12) !== "WEBP"
  ) {
    return "invalid";
  }
  const riffSize = value.readUInt32LE(4);
  if (riffSize < 4 || 8 + riffSize !== value.length) {
    return "invalid";
  }

  let offset = 12;
  while (offset + 8 <= value.length) {
    const type = value.toString("ascii", offset, offset + 4);
    const length = value.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd > value.length) return "invalid";
    if (type === "EXIF") {
      const exif = inspectTiff(tiffPayload(value.subarray(dataStart, dataEnd)));
      if (exif !== "none") return exif;
    }
    offset = dataEnd + (length % 2);
  }
  return offset === value.length ? "none" : "invalid";
}

export function inspectExifBuffer(value: Buffer): PhotoMetadataInspection {
  return inspectTiff(tiffPayload(value));
}

export function inspectPhotoMetadata(
  contentType: string,
  value: Buffer,
): PhotoMetadataInspection {
  switch (contentType) {
    case "image/jpeg":
      return inspectJpeg(value);
    case "image/png":
      return inspectPng(value);
    case "image/webp":
      return inspectWebp(value);
    default:
      return "invalid";
  }
}
