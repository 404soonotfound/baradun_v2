import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { describe, expect, it, vi } from "vitest";
import { InquiryPhotos } from "./photos";
import { isInquiryUploadResponse } from "./validation";

const PENDING = "pending/0123456789abcdef0123456789abcdef/0123456789abcdef";
const ACCEPTED = "accepted/0123456789abcdef0123456789abcdef/0123456789abcdef";
const notFound = () => Object.assign(new Error("없음"), { name: "NotFound" });

function gpsJpeg(): Buffer {
  const tiff = Buffer.alloc(26);
  tiff.write("II", 0, "ascii");
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(1, 8);
  tiff.writeUInt16LE(0x8825, 10);
  const payload = Buffer.concat([Buffer.from("Exif\0\0", "binary"), tiff]);
  const length = Buffer.alloc(2);
  length.writeUInt16BE(payload.length + 2);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe1]),
    length,
    payload,
    Buffer.from([0xff, 0xd9]),
  ]);
}

describe("문의 사진 처리", () => {
  it("presigned POST에 파일당 5MiB 제한을 넣는다", async () => {
    const presign = vi.fn(async () => ({
      url: "https://upload.example.invalid",
      fields: { key: "generated" },
    })) as unknown as typeof createPresignedPost;
    const photos = new InquiryPhotos({} as S3Client, "Photos", presign);
    const result = await photos.createUploads(
      [{ contentType: "image/jpeg", size: 5 * 1024 * 1024 }],
      new Date("2026-10-26T00:00:00.000Z"),
    );

    expect(result).toHaveLength(1);
    expect(presign).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        Conditions: expect.arrayContaining([
          ["content-length-range", 1, 5 * 1024 * 1024],
        ]),
      }),
    );
  });

  it("GPS EXIF가 있는 사진만 거부하고 삭제한다", async () => {
    const body = gpsJpeg();
    const commands: unknown[] = [];
    const s3 = {
      send: vi.fn(async (command: unknown) => {
        commands.push(command);
        if (command instanceof HeadObjectCommand) {
          return {
            ContentLength: body.length,
            ContentType: "image/jpeg",
            ETag: '"photo-etag"',
          };
        }
        if (command instanceof GetObjectCommand) {
          return { Body: { transformToByteArray: async () => body } };
        }
        if (command instanceof DeleteObjectCommand) return {};
        throw new Error("예상하지 않은 명령");
      }),
    } as unknown as S3Client;
    const photos = new InquiryPhotos(s3, "Photos");

    await expect(
      photos.inspect({
        photoId: "0123456789abcdef",
        key: "pending/0123456789abcdef0123456789abcdef/0123456789abcdef",
      }),
    ).resolves.toEqual({
      result: {
        photoId: "0123456789abcdef",
        status: "rejected",
        reason: "location_metadata",
      },
    });
    expect(commands.some((command) => command instanceof DeleteObjectCommand)).toBe(
      true,
    );
  });

  it("검사를 통과한 사진을 재업로드할 수 없는 경로로 복사한다", async () => {
    const body = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const commands: unknown[] = [];
    const s3 = {
      send: vi.fn(async (command: unknown) => {
        commands.push(command);
        if (command instanceof HeadObjectCommand) {
          return {
            ContentLength: body.length,
            ContentType: "image/jpeg",
            ETag: '"photo-etag"',
          };
        }
        if (command instanceof GetObjectCommand) {
          return { Body: { transformToByteArray: async () => body } };
        }
        if (
          command instanceof CopyObjectCommand ||
          command instanceof DeleteObjectCommand
        ) {
          return {};
        }
        throw new Error("예상하지 않은 명령");
      }),
    } as unknown as S3Client;
    const photos = new InquiryPhotos(s3, "Photos");

    await expect(
      photos.inspect({
        photoId: "0123456789abcdef",
        key: "pending/0123456789abcdef0123456789abcdef/0123456789abcdef",
      }),
    ).resolves.toEqual({
      result: { photoId: "0123456789abcdef", status: "accepted" },
      acceptedKey:
        "accepted/0123456789abcdef0123456789abcdef/0123456789abcdef",
    });
    const copy = commands.find(
      (command) => command instanceof CopyObjectCommand,
    ) as CopyObjectCommand;
    expect(copy.input).toMatchObject({
      CopySourceIfMatch: '"photo-etag"',
      Key: "accepted/0123456789abcdef0123456789abcdef/0123456789abcdef",
    });
  });

  it("실제 SDK 양식(가짜 키, 네트워크 없음)이 계약 InquiryUploadResponse와 맞는다", async () => {
    const s3 = new S3Client({
      region: "ap-northeast-2",
      credentials: {
        accessKeyId: "AKIDEXAMPLE",
        secretAccessKey: "test-secret", // 시험용 가짜 값
        sessionToken: "test-session",
      },
    });
    const photos = new InquiryPhotos(s3, "baradunv2-photos-test");
    const uploads = await photos.createUploads(
      [
        { contentType: "image/png", size: 10 },
        { contentType: "image/webp", size: 10 },
      ],
      new Date(),
    );
    expect(isInquiryUploadResponse({ uploads })).toBe(true);
    for (const upload of uploads) {
      expect(upload.method).toBe("POST");
      expect(upload.url).toBe(
        "https://baradunv2-photos-test.s3.ap-northeast-2.amazonaws.com/",
      );
      expect(upload.fields.key).toBe(upload.key);
      expect(upload.fields.bucket).toBe("baradunv2-photos-test");
    }
    expect(uploads.map((upload) => upload.fields["Content-Type"])).toEqual([
      "image/png",
      "image/webp",
    ]);
    const policy = JSON.parse(
      Buffer.from(uploads[0]!.fields.Policy, "base64").toString("utf8"),
    ) as { conditions: unknown[] };
    expect(policy.conditions).toEqual(
      expect.arrayContaining([
        ["eq", "$Content-Type", "image/png"],
        ["content-length-range", 1, 5 * 1024 * 1024],
        { key: uploads[0]!.key },
        { bucket: "baradunv2-photos-test" },
      ]),
    );
  });

  it("대기 사진이 없어도 앞선 같은 요청이 검사를 마친 accepted/ 사본이 있으면 통과로 봄", async () => {
    const commands: unknown[] = [];
    const s3 = {
      send: vi.fn(async (command: unknown) => {
        commands.push(command);
        if (command instanceof HeadObjectCommand) {
          if (command.input.Key === PENDING) throw notFound();
          return { ContentLength: 4, ContentType: "image/jpeg", ETag: '"e"' };
        }
        throw new Error("예상하지 않은 명령");
      }),
    } as unknown as S3Client;
    await expect(
      new InquiryPhotos(s3, "Photos").inspect({
        photoId: "0123456789abcdef",
        key: PENDING,
      }),
    ).resolves.toEqual({
      result: { photoId: "0123456789abcdef", status: "accepted" },
      acceptedKey: ACCEPTED,
    });
    expect(
      commands.map((command) => (command as HeadObjectCommand).input.Key),
    ).toEqual([PENDING, ACCEPTED]);
  });

  it("검사 도중 앞선 요청이 대기 사진을 옮겨 GET이 NoSuchKey여도 accepted/ 사본을 봄", async () => {
    const s3 = {
      send: vi.fn(async (command: unknown) => {
        if (command instanceof HeadObjectCommand)
          return { ContentLength: 4, ContentType: "image/jpeg", ETag: '"e"' };
        if (command instanceof GetObjectCommand)
          throw Object.assign(new Error("없음"), { name: "NoSuchKey" });
        throw new Error("예상하지 않은 명령");
      }),
    } as unknown as S3Client;
    await expect(
      new InquiryPhotos(s3, "Photos").inspect({
        photoId: "0123456789abcdef",
        key: PENDING,
      }),
    ).resolves.toMatchObject({ result: { status: "accepted" } });
  });

  it("대기·accepted/ 모두 없으면 not_found, accepted/ 확인 오류는 거절로 바꾸지 않고 던짐", async () => {
    const missing = {
      send: vi.fn(async () => {
        throw notFound();
      }),
    } as unknown as S3Client;
    await expect(
      new InquiryPhotos(missing, "Photos").inspect({
        photoId: "0123456789abcdef",
        key: PENDING,
      }),
    ).resolves.toEqual({
      result: {
        photoId: "0123456789abcdef",
        status: "rejected",
        reason: "not_found",
      },
    });

    const outage = {
      send: vi.fn(async (command: HeadObjectCommand) => {
        if (command.input.Key === PENDING) throw notFound();
        throw new Error("s3 장애(시험)");
      }),
    } as unknown as S3Client;
    await expect(
      new InquiryPhotos(outage, "Photos").inspect({
        photoId: "0123456789abcdef",
        key: PENDING,
      }),
    ).rejects.toThrow("s3 장애(시험)");
  });
});
