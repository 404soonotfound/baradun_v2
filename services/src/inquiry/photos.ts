import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import type {
  InquiryPhotoReference,
  InquiryPhotoResult,
  InquiryUploadFields,
  InquiryUploadPhoto,
  InquiryUploadTarget,
} from "@baradun/contracts";
import { randomBytes } from "node:crypto";
import sharp from "sharp";
import { inspectExifBuffer, inspectPhotoMetadata } from "./exif";
import {
  INQUIRY_MAX_PHOTO_BYTES,
  INQUIRY_MAX_PHOTO_DIMENSION,
  INQUIRY_MAX_PHOTO_PIXELS,
  INQUIRY_PHOTO_QUALITY,
  INQUIRY_UPLOAD_EXPIRES_SECONDS,
} from "./policy";

type Presign = typeof createPresignedPost;
type SupportedPhotoFormat = "jpeg" | "png" | "webp";

const CONTENT_TYPE_TO_FORMAT: Readonly<Record<string, SupportedPhotoFormat>> = {
  "image/jpeg": "jpeg",
  "image/png": "png",
  "image/webp": "webp",
};

function errorName(error: unknown): string {
  return typeof error === "object" && error !== null && "name" in error
    ? String(error.name)
    : "";
}

function isMissing(error: unknown): boolean {
  const name = errorName(error);
  return name === "NotFound" || name === "NoSuchKey";
}

function isPreconditionFailed(error: unknown): boolean {
  return errorName(error) === "PreconditionFailed";
}

export type ReencodedPhotoResult =
  | { readonly status: "ok"; readonly body: Buffer }
  | { readonly status: "gps" | "invalid" };

// 업로드된 사진을 완전히 디코딩·검증한 뒤 메타데이터 없이 다시 인코딩함(BRD-116)
export async function decodeAndReencodePhoto(
  contentType: string,
  body: Buffer,
): Promise<ReencodedPhotoResult> {
  const format = CONTENT_TYPE_TO_FORMAT[contentType];
  if (
    !format ||
    body.length < 1 ||
    body.length > INQUIRY_MAX_PHOTO_BYTES
  ) {
    return { status: "invalid" };
  }

  const metadata = inspectPhotoMetadata(contentType, body);
  if (metadata === "gps") return { status: "gps" };
  if (metadata !== "none") return { status: "invalid" };

  const options = {
    failOn: "error" as const,
    limitInputPixels: INQUIRY_MAX_PHOTO_PIXELS,
    sequentialRead: true,
  };

  try {
    const info = await sharp(body, options).metadata();
    if (info.exif) {
      const exif = inspectExifBuffer(info.exif);
      if (exif === "gps") return { status: "gps" };
      if (exif !== "none") return { status: "invalid" };
    }
    if (
      info.format !== format ||
      typeof info.width !== "number" ||
      typeof info.height !== "number" ||
      info.width < 1 ||
      info.height < 1 ||
      info.width > INQUIRY_MAX_PHOTO_DIMENSION ||
      info.height > INQUIRY_MAX_PHOTO_DIMENSION ||
      info.width * info.height > INQUIRY_MAX_PHOTO_PIXELS ||
      (info.pages !== undefined && info.pages !== 1) ||
      (info.pageHeight !== undefined && info.pageHeight !== info.height)
    ) {
      return { status: "invalid" };
    }

    // EXIF 회전만 픽셀에 반영하고 모든 메타데이터(EXIF·XMP·IPTC·프로필·주석)는 버림
    const rotated = sharp(body, options).rotate();
    const reencoded =
      format === "jpeg"
        ? await rotated.jpeg({ quality: INQUIRY_PHOTO_QUALITY }).toBuffer()
        : format === "png"
          ? await rotated.png().toBuffer()
          : await rotated.webp({ quality: INQUIRY_PHOTO_QUALITY }).toBuffer();

    if (
      reencoded.length < 1 ||
      reencoded.length > INQUIRY_MAX_PHOTO_BYTES ||
      inspectPhotoMetadata(contentType, reencoded) !== "none"
    ) {
      return { status: "invalid" };
    }
    return { status: "ok", body: reencoded };
  } catch {
    return { status: "invalid" };
  }
}

export interface InspectedPhoto {
  readonly result: InquiryPhotoResult;
  readonly acceptedKey?: string;
}

export class InquiryPhotos {
  constructor(
    private readonly s3: S3Client,
    private readonly bucketName: string,
    private readonly presign: Presign = createPresignedPost,
  ) {}

  async createUploads(
    photos: InquiryUploadPhoto[],
    now: Date,
  ): Promise<InquiryUploadTarget[]> {
    const sessionId = randomBytes(16).toString("hex");
    const expiresAt = new Date(
      now.getTime() + INQUIRY_UPLOAD_EXPIRES_SECONDS * 1000,
    ).toISOString();

    return Promise.all(
      photos.map(async (photo) => {
        const photoId = randomBytes(8).toString("hex");
        const key = `pending/${sessionId}/${photoId}`;
        const target = await this.presign(this.s3, {
          Bucket: this.bucketName,
          Key: key,
          Expires: INQUIRY_UPLOAD_EXPIRES_SECONDS,
          Fields: { "Content-Type": photo.contentType },
          Conditions: [
            ["eq", "$Content-Type", photo.contentType],
            ["content-length-range", 1, INQUIRY_MAX_PHOTO_BYTES],
          ],
        });
        // fields는 SDK가 만든 문자열 칸. 계약 모양(InquiryUploadFields)은 handler가 응답 전에 검사함
        return {
          photoId,
          key,
          method: "POST" as const,
          url: target.url,
          fields: target.fields as unknown as InquiryUploadFields,
          expiresAt,
        };
      }),
    );
  }

  async inspect(photo: InquiryPhotoReference): Promise<InspectedPhoto> {
    const acceptedKey = photo.key.replace(/^pending\//, "accepted/");
    try {
      const head = await this.s3.send(
        new HeadObjectCommand({ Bucket: this.bucketName, Key: photo.key }),
      );
      if (
        head.ContentLength === undefined ||
        head.ContentLength < 1 ||
        head.ContentLength > INQUIRY_MAX_PHOTO_BYTES ||
        !head.ContentType ||
        !head.ETag ||
        !(head.ContentType in CONTENT_TYPE_TO_FORMAT)
      ) {
        await this.removeBestEffort(photo.key);
        return {
          result: {
            photoId: photo.photoId,
            status: "rejected",
            reason: "invalid_file",
          },
        };
      }

      const object = await this.s3.send(
        new GetObjectCommand({
          Bucket: this.bucketName,
          Key: photo.key,
          IfMatch: head.ETag,
        }),
      );
      if (!object.Body) {
        await this.removeBestEffort(photo.key);
        return {
          result: {
            photoId: photo.photoId,
            status: "rejected",
            reason: "invalid_file",
          },
        };
      }
      const body = Buffer.from(await object.Body.transformToByteArray());
      const decoded = await decodeAndReencodePhoto(head.ContentType, body);
      if (decoded.status !== "ok") {
        await this.removeBestEffort(photo.key);
        return {
          result: {
            photoId: photo.photoId,
            status: "rejected",
            reason:
              decoded.status === "gps" ? "location_metadata" : "invalid_file",
          },
        };
      }
      // 원본 바이트는 저장하지 않고 메타데이터를 지운 재인코딩 결과만 accepted/에 올림(BRD-116)
      await this.s3.send(
        new PutObjectCommand({
          Bucket: this.bucketName,
          Key: acceptedKey,
          Body: decoded.body,
          ContentType: head.ContentType,
        }),
      );
      await this.removeBestEffort(photo.key);
      return {
        result: { photoId: photo.photoId, status: "accepted" },
        acceptedKey,
      };
    } catch (error) {
      if (isPreconditionFailed(error)) {
        await this.removeBestEffort(photo.key);
        return {
          result: {
            photoId: photo.photoId,
            status: "rejected",
            reason: "invalid_file",
          },
        };
      }
      if (!isMissing(error)) throw error;
      // 같은 멱등 키의 앞선 요청(재시도·동시 요청)이 이미 검사를 마치고 accepted/로 옮겼으면 그 결과를 씀.
      // accepted/에는 디코딩·재인코딩을 통과한 사진만 저장됨
      if (await this.exists(acceptedKey)) {
        return {
          result: { photoId: photo.photoId, status: "accepted" },
          acceptedKey,
        };
      }
      return {
        result: {
          photoId: photo.photoId,
          status: "rejected",
          reason: "not_found",
        },
      };
    }
  }

  private async exists(key: string): Promise<boolean> {
    try {
      await this.s3.send(
        new HeadObjectCommand({ Bucket: this.bucketName, Key: key }),
      );
      return true;
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
  }

  async remove(key: string): Promise<void> {
    await this.s3.send(
      new DeleteObjectCommand({ Bucket: this.bucketName, Key: key }),
    );
  }

  private async removeBestEffort(key: string): Promise<void> {
    try {
      await this.remove(key);
    } catch {
      // 수명 주기 삭제를 남겨 둔 비공개 객체의 후속 정리 수단으로 사용함
    }
  }
}
