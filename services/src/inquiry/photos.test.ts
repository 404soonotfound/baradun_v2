import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import type { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { describe, expect, it, vi } from "vitest";
import { InquiryPhotos } from "./photos";

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
});
