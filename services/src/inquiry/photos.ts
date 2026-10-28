import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
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
import { inspectPhotoMetadata } from "./exif";
import {
  INQUIRY_MAX_PHOTO_BYTES,
  INQUIRY_UPLOAD_EXPIRES_SECONDS,
} from "./policy";

type Presign = typeof createPresignedPost;

const CONTENT_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

function isMissing(error: unknown): boolean {
  const name =
    typeof error === "object" && error !== null && "name" in error
      ? String(error.name)
      : "";
  return name === "NotFound" || name === "NoSuchKey";
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
        !CONTENT_TYPES.has(head.ContentType)
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
        new GetObjectCommand({ Bucket: this.bucketName, Key: photo.key }),
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
      const metadata = inspectPhotoMetadata(head.ContentType, body);
      if (metadata !== "none") {
        await this.removeBestEffort(photo.key);
        return {
          result: {
            photoId: photo.photoId,
            status: "rejected",
            reason:
              metadata === "gps" ? "location_metadata" : "invalid_file",
          },
        };
      }
      await this.s3.send(
        new CopyObjectCommand({
          Bucket: this.bucketName,
          Key: acceptedKey,
          CopySource: `${this.bucketName}/${photo.key}`,
          CopySourceIfMatch: head.ETag,
        }),
      );
      await this.removeBestEffort(photo.key);
      return {
        result: { photoId: photo.photoId, status: "accepted" },
        acceptedKey,
      };
    } catch (error) {
      if (!isMissing(error)) throw error;
      // 같은 멱등 키의 앞선 요청(재시도·동시 요청)이 이미 검사를 마치고 accepted/로 옮겼으면 그 결과를 씀.
      // accepted/에는 검사를 통과한 사진만 복사됨
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
