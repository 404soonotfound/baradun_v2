import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { inspectPhotoMetadata } from "./exif";
import { decodeAndReencodePhoto, InquiryPhotos } from "./photos";
import { isInquiryUploadResponse } from "./validation";

const PENDING = "pending/0123456789abcdef0123456789abcdef/0123456789abcdef";
const ACCEPTED = "accepted/0123456789abcdef0123456789abcdef/0123456789abcdef";
const notFound = () => Object.assign(new Error("없음"), { name: "NotFound" });

async function samplePhoto(
  format: "jpeg" | "png" | "webp",
  options: {
    width?: number;
    height?: number;
    orientation?: number;
    exif?: Record<string, Record<string, string>>;
  } = {},
): Promise<Buffer> {
  let pipeline = sharp({
    create: {
      width: options.width ?? 24,
      height: options.height ?? 16,
      channels: 3,
      background: { r: 20, g: 80, b: 140 },
    },
  });
  if (options.orientation !== undefined || options.exif !== undefined) {
    pipeline = pipeline.withMetadata({
      ...(options.orientation !== undefined
        ? { orientation: options.orientation }
        : {}),
      ...(options.exif !== undefined ? { exif: options.exif } : {}),
    });
  }
  if (format === "jpeg") return pipeline.jpeg({ quality: 90 }).toBuffer();
  if (format === "png") return pipeline.png().toBuffer();
  return pipeline.webp({ quality: 90 }).toBuffer();
}

function mockS3ForInspect(contentType: string, body: Buffer) {
  const commands: unknown[] = [];
  const s3 = {
    send: vi.fn(async (command: unknown) => {
      commands.push(command);
      if (command instanceof HeadObjectCommand) {
        return {
          ContentLength: body.length,
          ContentType: contentType,
          ETag: '"photo-etag"',
        };
      }
      if (command instanceof GetObjectCommand) {
        return { Body: { transformToByteArray: async () => body } };
      }
      if (
        command instanceof PutObjectCommand ||
        command instanceof DeleteObjectCommand
      ) {
        return {};
      }
      throw new Error("예상하지 않은 명령");
    }),
  } as unknown as S3Client;
  return { s3, commands };
}

describe("문의 사진 처리", () => {
  it("presigned POST에 파일당 4MiB 제한을 넣는다", async () => {
    const presign = vi.fn(async () => ({
      url: "https://upload.example.invalid",
      fields: { key: "generated" },
    })) as unknown as typeof createPresignedPost;
    const photos = new InquiryPhotos({} as S3Client, "Photos", presign);
    const result = await photos.createUploads(
      [{ contentType: "image/jpeg", size: 4 * 1024 * 1024 }],
      new Date("2026-10-26T00:00:00.000Z"),
    );

    expect(result).toHaveLength(1);
    expect(presign).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        Conditions: expect.arrayContaining([
          ["content-length-range", 1, 4 * 1024 * 1024],
        ]),
      }),
    );
  });

  it.each([
    ["image/jpeg", "jpeg" as const],
    ["image/png", "png" as const],
    ["image/webp", "webp" as const],
  ])(
    "GPS EXIF가 있는 %s 사진은 저장하지 않고 location_metadata로 거부·삭제한다",
    async (contentType, format) => {
      const body = await samplePhoto(format, {
        exif: {
          IFD0: { Make: "TestPhone" },
          IFD3: {
            GPSLatitudeRef: "N",
            GPSLatitude: "35/1 10/1 0/1",
            GPSLongitudeRef: "E",
            GPSLongitude: "129/1 10/1 0/1",
          },
        },
      });
      const { s3, commands } = mockS3ForInspect(contentType, body);
      const photos = new InquiryPhotos(s3, "Photos");

      await expect(
        photos.inspect({
          photoId: "0123456789abcdef",
          key: PENDING,
        }),
      ).resolves.toEqual({
        result: {
          photoId: "0123456789abcdef",
          status: "rejected",
          reason: "location_metadata",
        },
      });
      expect(
        commands.some((command) => command instanceof PutObjectCommand),
      ).toBe(false);
      expect(
        commands.some((command) => command instanceof CopyObjectCommand),
      ).toBe(false);
      expect(
        commands.some((command) => command instanceof DeleteObjectCommand),
      ).toBe(true);
    },
  );

  it.each([
    ["image/jpeg", "jpeg" as const],
    ["image/png", "png" as const],
    ["image/webp", "webp" as const],
  ])(
    "검사를 통과한 %s 사진은 원본 복사 대신 디코딩·재인코딩한 결과만 accepted/에 저장한다",
    async (contentType, format) => {
      const body = await samplePhoto(format, {
        ...(format === "jpeg" ? { orientation: 6 } : {}),
        exif: {
          IFD0: {
            Make: "SecretCameraMaker",
            Model: "SecretDeviceModel",
            Software: "SecretEditor 1.0",
            ImageDescription: "SecretUserComment",
          },
        },
      });
      // 입력에는 실제로 EXIF 메타데이터 문자열이 들어 있음
      expect(body.includes(Buffer.from("SecretCameraMaker"))).toBe(true);

      const { s3, commands } = mockS3ForInspect(contentType, body);
      const photos = new InquiryPhotos(s3, "Photos");

      await expect(
        photos.inspect({
          photoId: "0123456789abcdef",
          key: PENDING,
        }),
      ).resolves.toEqual({
        result: { photoId: "0123456789abcdef", status: "accepted" },
        acceptedKey: ACCEPTED,
      });

      expect(
        commands.some((command) => command instanceof CopyObjectCommand),
      ).toBe(false);
      const get = commands.find(
        (command) => command instanceof GetObjectCommand,
      ) as GetObjectCommand;
      expect(get.input).toMatchObject({
        Key: PENDING,
        IfMatch: '"photo-etag"',
      });

      const put = commands.find(
        (command) => command instanceof PutObjectCommand,
      ) as PutObjectCommand;
      expect(put).toBeDefined();
      expect(put.input).toMatchObject({
        Bucket: "Photos",
        Key: ACCEPTED,
        ContentType: contentType,
      });

      const stored = Buffer.from(put.input.Body as Uint8Array);
      expect(stored.equals(body)).toBe(false);
      expect(inspectPhotoMetadata(contentType, stored)).toBe("none");
      for (const secret of [
        "SecretCameraMaker",
        "SecretDeviceModel",
        "SecretEditor",
        "SecretUserComment",
        "Exif",
      ]) {
        expect(stored.includes(Buffer.from(secret)), secret).toBe(false);
      }

      const storedMeta = await sharp(stored, { failOn: "error" }).metadata();
      expect(storedMeta.format).toBe(format);
      expect(storedMeta.exif).toBeUndefined();
      expect(storedMeta.xmp).toBeUndefined();
      expect(storedMeta.iptc).toBeUndefined();
      expect(storedMeta.comments).toBeUndefined();
      expect(storedMeta.orientation).toBeUndefined();
      if (format === "jpeg") {
        // EXIF 회전(orientation: 6)이 픽셀에 반영되어 24×16이 16×24로 저장됨
        expect({ width: storedMeta.width, height: storedMeta.height }).toEqual({
          width: 16,
          height: 24,
        });
      }
      expect(
        commands.some((command) => command instanceof DeleteObjectCommand),
      ).toBe(true);
    },
  );

  it("손상·변형·형식 불일치 사진은 저장하지 않고 invalid_file로 거부·삭제한다", async () => {
    const validJpeg = await samplePhoto("jpeg");
    const validPng = await samplePhoto("png");
    const validWebp = await samplePhoto("webp");

    const corruptedPng = Buffer.from(validPng);
    corruptedPng.fill(0xff, corruptedPng.length - 24, corruptedPng.length - 14);

    const corruptedWebp = Buffer.from(validWebp);
    corruptedWebp.fill(0x00, 20, Math.min(30, corruptedWebp.length));

    const malformedCases: ReadonlyArray<readonly [string, string, Buffer]> = [
      ["헤더만 있는 빈 JPEG", "image/jpeg", Buffer.from([0xff, 0xd8, 0xff, 0xd9])],
      [
        "스캔 데이터가 중간에 잘린 JPEG",
        "image/jpeg",
        validJpeg.subarray(0, validJpeg.length - 6),
      ],
      [
        "EOI 뒤에 여분 바이트를 붙인 JPEG",
        "image/jpeg",
        Buffer.concat([validJpeg, Buffer.from("polyglot-tail")]),
      ],
      ["압축 데이터가 손상된 PNG", "image/png", corruptedPng],
      [
        "IEND 뒤에 여분 바이트를 붙인 PNG",
        "image/png",
        Buffer.concat([validPng, Buffer.from("extra")]),
      ],
      ["프레임 헤더가 손상된 WebP", "image/webp", corruptedWebp],
      [
        "Content-Type(image/jpeg)과 실제 포맷(PNG)이 다른 파일",
        "image/jpeg",
        validPng,
      ],
    ];

    for (const [label, contentType, badBody] of malformedCases) {
      const { s3, commands } = mockS3ForInspect(contentType, badBody);
      const photos = new InquiryPhotos(s3, "Photos");
      const inspected = await photos.inspect({
        photoId: "0123456789abcdef",
        key: PENDING,
      });

      expect(inspected, label).toEqual({
        result: {
          photoId: "0123456789abcdef",
          status: "rejected",
          reason: "invalid_file",
        },
      });
      expect(
        commands.some((command) => command instanceof PutObjectCommand),
        label,
      ).toBe(false);
      expect(
        commands.some((command) => command instanceof DeleteObjectCommand),
        label,
      ).toBe(true);
    }
  });

  it("가로·세로 4096px 초과 또는 16,777,216px 초과(압축 폭탄) 이미지는 거부·삭제한다", async () => {
    const tooWide = await sharp({
      create: {
        width: 4097,
        height: 8,
        channels: 3,
        background: { r: 0, g: 0, b: 0 },
      },
    })
      .png({ compressionLevel: 9 })
      .toBuffer();

    const tooTall = await sharp({
      create: {
        width: 8,
        height: 4097,
        channels: 3,
        background: { r: 0, g: 0, b: 0 },
      },
    })
      .png({ compressionLevel: 9 })
      .toBuffer();

    const pixelBomb = await sharp({
      create: {
        width: 4200,
        height: 4000,
        channels: 3,
        background: { r: 0, g: 0, b: 0 },
      },
    })
      .png({ compressionLevel: 9 })
      .toBuffer();

    for (const [label, oversized] of [
      ["가로 상한 초과(4097×8)", tooWide],
      ["세로 상한 초과(8×4097)", tooTall],
      ["총 픽셀 상한 초과(4200×4000)", pixelBomb],
    ] as const) {
      expect(await decodeAndReencodePhoto("image/png", oversized), label).toEqual(
        { status: "invalid" },
      );

      const { s3, commands } = mockS3ForInspect("image/png", oversized);
      const inspected = await new InquiryPhotos(s3, "Photos").inspect({
        photoId: "0123456789abcdef",
        key: PENDING,
      });
      expect(inspected, label).toEqual({
        result: {
          photoId: "0123456789abcdef",
          status: "rejected",
          reason: "invalid_file",
        },
      });
      expect(
        commands.some((command) => command instanceof PutObjectCommand),
        label,
      ).toBe(false);
    }
  });

  it("HeadObject 뒤 객체가 바뀌어 GetObject ETag 조건이 깨지면 invalid_file로 거부한다", async () => {
    const commands: unknown[] = [];
    const s3 = {
      send: vi.fn(async (command: unknown) => {
        commands.push(command);
        if (command instanceof HeadObjectCommand) {
          return {
            ContentLength: 100,
            ContentType: "image/jpeg",
            ETag: '"etag-1"',
          };
        }
        if (command instanceof GetObjectCommand) {
          throw Object.assign(new Error("불일치"), {
            name: "PreconditionFailed",
          });
        }
        if (command instanceof DeleteObjectCommand) return {};
        throw new Error("예상하지 않은 명령");
      }),
    } as unknown as S3Client;

    await expect(
      new InquiryPhotos(s3, "Photos").inspect({
        photoId: "0123456789abcdef",
        key: PENDING,
      }),
    ).resolves.toEqual({
      result: {
        photoId: "0123456789abcdef",
        status: "rejected",
        reason: "invalid_file",
      },
    });
    expect(commands.some((c) => c instanceof PutObjectCommand)).toBe(false);
    expect(commands.some((c) => c instanceof DeleteObjectCommand)).toBe(true);
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
        ["content-length-range", 1, 4 * 1024 * 1024],
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
