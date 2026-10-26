import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import type { SnapshotStore, TaggedFile } from "./types";

// S3 게시 저장소 (BRD-61 PR ②, 아키텍처 6.2·17.2)
// S3 호출은 이 파일에만 둠. 게시 순서·분류는 SnapshotStore 인터페이스만 씀(이식성)
// 권한은 publisher 역할의 data/ 아래 Get·Put·Delete·List뿐(infra/lib/publish/publisher-role.ts)
// 조건부 쓰기(If-Match·If-None-Match): S3 공식 문서 'conditional writes' 기준
//   조건이 어긋나면 412, 같은 순간 겹친 요청은 409, If-Match 대상이 그 사이 지워졌으면 404
//   → 셋 다 "다른 실행이 먼저 바꿈"으로 보고 false. 부르는 쪽이 다시 읽고 판단함

const VERSION_PREFIX = /^data\/([0-9]{8}T[0-9]{6}Z)\/$/;
const CONTENT_TYPE = "application/json; charset=utf-8";
// DeleteObjects 한 번에 지울 수 있는 최대 개수(S3 제한)
const DELETE_BATCH = 1000;

// 클라이언트에서 쓰는 것만(시험에서 가짜로 바꾸기 쉽게)
export type S3Sender = Pick<S3Client, "send">;

interface ErrorLike {
  readonly name?: string;
  readonly $metadata?: { readonly httpStatusCode?: number };
}

function statusOf(error: unknown): number | undefined {
  return (error as ErrorLike | null)?.$metadata?.httpStatusCode;
}

function isMissing(error: unknown): boolean {
  const name = (error as ErrorLike | null)?.name;
  return name === "NoSuchKey" || name === "NotFound" || statusOf(error) === 404;
}

const CONDITION_FAILED = new Set([404, 409, 412]);

export class S3SnapshotStore implements SnapshotStore {
  constructor(
    private readonly client: S3Sender,
    private readonly bucket: string,
  ) {}

  async putFile(path: string, body: string, cacheControl: string) {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: path,
        Body: body,
        ContentType: CONTENT_TYPE,
        CacheControl: cacheControl,
      }),
    );
  }

  async putFileIf(
    path: string,
    body: string,
    cacheControl: string,
    expectedEtag: string | null,
  ) {
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: path,
          Body: body,
          ContentType: CONTENT_TYPE,
          CacheControl: cacheControl,
          ...(expectedEtag === null
            ? { IfNoneMatch: "*" }
            : { IfMatch: expectedEtag }),
        }),
      );
      return true;
    } catch (error) {
      const status = statusOf(error);
      if (status !== undefined && CONDITION_FAILED.has(status)) return false;
      throw error;
    }
  }

  async getFile(path: string) {
    return (await this.getTaggedFile(path))?.body ?? null;
  }

  async getTaggedFile(path: string): Promise<TaggedFile | null> {
    try {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: path }),
      );
      // Body는 스트림. 끝까지 읽어야 연결이 풀림(SDK v3)
      const body = await result.Body?.transformToString("utf-8");
      if (body === undefined || result.ETag === undefined) {
        throw new Error(`S3 응답에 본문·ETag 없음: ${path}`);
      }
      return { body, etag: result.ETag };
    } catch (error) {
      if (isMissing(error)) return null;
      // 없는 파일에 S3가 404 대신 403을 줄 수 있음(목록 권한이 data/ 접두어 조건부라 GetObject 요청에는 적용되지 않을 수 있음)
      // → 목록으로 실제로 없는지 확인한 뒤에만 null. 목록에 있으면 진짜 거부이므로 그대로 던짐
      if (statusOf(error) === 403 && !(await this.exists(path))) return null;
      throw error;
    }
  }

  // 그 경로의 파일이 목록에 있는지(접두어 = 경로 자체, 1개만)
  private async exists(path: string): Promise<boolean> {
    const page = await this.client.send(
      new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: path,
        MaxKeys: 1,
      }),
    );
    return (page.Contents ?? []).some(({ Key }) => Key === path);
  }

  // data/ 바로 아래 폴더 이름 중 snapshotVersion 형식만. 1,000개가 넘으면 이어서 읽음
  async listVersions() {
    const versions: string[] = [];
    let token: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: "data/",
          Delimiter: "/",
          ContinuationToken: token,
        }),
      );
      for (const { Prefix } of page.CommonPrefixes ?? []) {
        const match = Prefix ? VERSION_PREFIX.exec(Prefix) : null;
        if (match) versions.push(match[1]!);
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token !== undefined);
    return versions.sort();
  }

  // 버전 경로 아래 파일을 모두 지움. 하나라도 못 지우면 던짐(다음 정리가 다시 지움)
  async deleteVersion(version: string) {
    if (!/^[0-9]{8}T[0-9]{6}Z$/.test(version)) {
      throw new RangeError(`버전 형식 오류: ${version}`);
    }
    const prefix = `data/${version}/`;
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: token,
        }),
      );
      for (const { Key } of page.Contents ?? []) {
        if (Key?.startsWith(prefix)) keys.push(Key);
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token !== undefined);

    for (let i = 0; i < keys.length; i += DELETE_BATCH) {
      const result = await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: {
            Objects: keys.slice(i, i + DELETE_BATCH).map((Key) => ({ Key })),
            Quiet: true,
          },
        }),
      );
      if ((result.Errors ?? []).length > 0) {
        throw new Error(
          `버전 경로 일부를 지우지 못함: ${version} (${result.Errors!.length}개)`,
        );
      }
    }
  }
}
