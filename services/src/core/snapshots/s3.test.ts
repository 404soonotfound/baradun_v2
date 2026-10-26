import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import { S3SnapshotStore, type S3Sender } from "./s3";

// S3 게시 저장소 (BRD-61 PR ②). 실제 AWS 없이 send()에 들어가는 요청과 오류 처리만 확인
// 가짜 버킷: 조건부 쓰기(If-Match·If-None-Match)를 S3처럼 412로 거절함

type Command = { input: Record<string, any> };

function s3Error(name: string, status: number) {
  return Object.assign(new Error(name), {
    name,
    $metadata: { httpStatusCode: status },
  });
}

function fakeBucket() {
  const objects = new Map<string, { body: string; etag: string; cc?: string }>();
  const sent: Command[] = [];
  let tag = 1;
  let pageSize = 1000;
  const sender: S3Sender = {
    send: (async (command: Command) => {
      sent.push(command);
      const input = command.input;
      if (command instanceof PutObjectCommand) {
        const current = objects.get(input.Key);
        if (input.IfNoneMatch === "*" && current) {
          throw s3Error("PreconditionFailed", 412);
        }
        if (input.IfMatch !== undefined) {
          if (!current) throw s3Error("NoSuchKey", 404);
          if (current.etag !== input.IfMatch) {
            throw s3Error("PreconditionFailed", 412);
          }
        }
        objects.set(input.Key, {
          body: input.Body,
          etag: `"e${tag++}"`,
          cc: input.CacheControl,
        });
        return {};
      }
      if (command instanceof GetObjectCommand) {
        const current = objects.get(input.Key);
        if (!current) throw s3Error("NoSuchKey", 404);
        return {
          ETag: current.etag,
          Body: { transformToString: async () => current.body },
        };
      }
      if (command instanceof ListObjectsV2Command) {
        const keys = [...objects.keys()]
          .filter((k) => k.startsWith(input.Prefix))
          .sort();
        const start = input.ContinuationToken ? Number(input.ContinuationToken) : 0;
        if (input.Delimiter === "/") {
          const prefixes = [
            ...new Set(
              keys
                .map((k) => k.slice(input.Prefix.length))
                .filter((rest) => rest.includes("/"))
                .map((rest) => `${input.Prefix}${rest.split("/")[0]}/`),
            ),
          ];
          const page = prefixes.slice(start, start + pageSize);
          const truncated = start + pageSize < prefixes.length;
          return {
            CommonPrefixes: page.map((Prefix) => ({ Prefix })),
            IsTruncated: truncated,
            NextContinuationToken: truncated ? String(start + pageSize) : undefined,
          };
        }
        const page = keys.slice(start, start + pageSize);
        const truncated = start + pageSize < keys.length;
        return {
          Contents: page.map((Key) => ({ Key })),
          IsTruncated: truncated,
          NextContinuationToken: truncated ? String(start + pageSize) : undefined,
        };
      }
      if (command instanceof DeleteObjectsCommand) {
        for (const { Key } of input.Delete.Objects) objects.delete(Key);
        return { Errors: [] };
      }
      throw new Error(`모르는 요청: ${command.constructor.name}`);
    }) as S3Sender["send"],
  };
  return {
    objects,
    sent,
    sender,
    setPageSize: (n: number) => {
      pageSize = n;
    },
  };
}

describe("S3SnapshotStore", () => {
  it("putFile: 버킷·경로·Cache-Control·JSON 형식으로 올림", async () => {
    const bucket = fakeBucket();
    const store = new S3SnapshotStore(bucket.sender, "site");
    await store.putFile("data/manifest.json", "{}", "public, max-age=60");
    expect(bucket.sent[0]!.input).toEqual({
      Bucket: "site",
      Key: "data/manifest.json",
      Body: "{}",
      ContentType: "application/json; charset=utf-8",
      CacheControl: "public, max-age=60",
    });
  });

  it("없는 파일은 null, 있으면 본문과 ETag", async () => {
    const bucket = fakeBucket();
    const store = new S3SnapshotStore(bucket.sender, "site");
    expect(await store.getFile("data/manifest.json")).toBeNull();
    expect(await store.getTaggedFile("data/manifest.json")).toBeNull();
    await store.putFile("data/manifest.json", '{"a":1}', "x");
    expect(await store.getTaggedFile("data/manifest.json")).toEqual({
      body: '{"a":1}',
      etag: '"e1"',
    });
  });

  it("없는 파일이 아닌 읽기 오류(권한·장애)는 null로 바꾸지 않고 던짐", async () => {
    const store = new S3SnapshotStore(
      {
        send: (async () => {
          throw s3Error("AccessDenied", 403);
        }) as S3Sender["send"],
      },
      "site",
    );
    await expect(store.getFile("data/manifest.json")).rejects.toThrow(
      "AccessDenied",
    );
  });

  it("없는 파일에 403이 오면 목록으로 확인해 정말 없을 때만 null", async () => {
    // 목록 권한이 data/ 접두어 조건부라 S3가 없는 파일에 404 대신 403을 주는 경우(첫 게시의 manifest)
    const sent: Command[] = [];
    let listed: string[] = [];
    const store = new S3SnapshotStore(
      {
        send: (async (command: Command) => {
          sent.push(command);
          if (command instanceof GetObjectCommand) {
            throw s3Error("AccessDenied", 403);
          }
          return { Contents: listed.map((Key) => ({ Key })) };
        }) as S3Sender["send"],
      },
      "site",
    );
    expect(await store.getTaggedFile("data/manifest.json")).toBeNull();
    expect(sent.at(-1)!.input).toMatchObject({
      Prefix: "data/manifest.json",
      MaxKeys: 1,
    });

    // 목록에 있으면 진짜 거부 → null로 바꾸지 않고 던짐
    listed = ["data/manifest.json"];
    await expect(store.getTaggedFile("data/manifest.json")).rejects.toThrow(
      "AccessDenied",
    );
    // 이름이 겹치는 다른 파일만 있으면 없음
    listed = ["data/manifest.json.bak"];
    expect(await store.getTaggedFile("data/manifest.json")).toBeNull();
  });

  it("putFileIf: 없을 때만(If-None-Match: *) — 이미 있으면 false", async () => {
    const bucket = fakeBucket();
    const store = new S3SnapshotStore(bucket.sender, "site");
    expect(await store.putFileIf("data/manifest.json", "1", "x", null)).toBe(
      true,
    );
    expect(bucket.sent.at(-1)!.input.IfNoneMatch).toBe("*");
    expect(await store.putFileIf("data/manifest.json", "2", "x", null)).toBe(
      false,
    );
    expect(bucket.objects.get("data/manifest.json")!.body).toBe("1");
  });

  it("putFileIf: 읽은 ETag일 때만(If-Match) — 그 사이 바뀌었으면 false", async () => {
    const bucket = fakeBucket();
    const store = new S3SnapshotStore(bucket.sender, "site");
    await store.putFile("data/manifest.json", "old", "x");
    const read = (await store.getTaggedFile("data/manifest.json"))!;
    // 다른 실행이 먼저 씀
    await store.putFile("data/manifest.json", "other", "x");
    expect(
      await store.putFileIf("data/manifest.json", "mine", "x", read.etag),
    ).toBe(false);
    expect(bucket.sent.at(-1)!.input.IfMatch).toBe(read.etag);
    expect(bucket.objects.get("data/manifest.json")!.body).toBe("other");

    const again = (await store.getTaggedFile("data/manifest.json"))!;
    expect(
      await store.putFileIf("data/manifest.json", "mine", "x", again.etag),
    ).toBe(true);
    expect(bucket.objects.get("data/manifest.json")!.body).toBe("mine");
  });

  it("putFileIf: 겹친 요청(409)도 false, 그 밖의 오류는 던짐", async () => {
    let error = s3Error("ConditionalRequestConflict", 409);
    const store = new S3SnapshotStore(
      {
        send: (async () => {
          throw error;
        }) as S3Sender["send"],
      },
      "site",
    );
    expect(await store.putFileIf("data/manifest.json", "x", "x", '"e1"')).toBe(
      false,
    );
    error = s3Error("InternalError", 500);
    await expect(
      store.putFileIf("data/manifest.json", "x", "x", '"e1"'),
    ).rejects.toThrow("InternalError");
  });

  it("listVersions: data/ 바로 아래 버전 형식 폴더만, 여러 쪽을 이어 읽음", async () => {
    const bucket = fakeBucket();
    const store = new S3SnapshotStore(bucket.sender, "site");
    for (const v of ["20261023T023000Z", "20261023T020000Z", "20261023T021500Z"]) {
      await store.putFile(`data/${v}/status.json`, "{}", "x");
    }
    await store.putFile("data/manifest.json", "{}", "x");
    await store.putFile("data/tmp/x.json", "{}", "x");
    bucket.setPageSize(2);
    expect(await store.listVersions()).toEqual([
      "20261023T020000Z",
      "20261023T021500Z",
      "20261023T023000Z",
    ]);
  });

  it("deleteVersion: 그 버전 경로만 지우고 manifest·다른 버전은 남김", async () => {
    const bucket = fakeBucket();
    const store = new S3SnapshotStore(bucket.sender, "site");
    for (const name of ["status.json", "beaches.json", "manifest.json"]) {
      await store.putFile(`data/20261023T020000Z/${name}`, "{}", "x");
    }
    await store.putFile("data/20261023T021500Z/status.json", "{}", "x");
    await store.putFile("data/manifest.json", "{}", "x");
    bucket.setPageSize(2);
    await store.deleteVersion("20261023T020000Z");
    expect([...bucket.objects.keys()].sort()).toEqual([
      "data/20261023T021500Z/status.json",
      "data/manifest.json",
    ]);
  });

  it("deleteVersion: 버전 형식이 아니면 지우지 않고 던짐(빈 값으로 data/ 전체를 지우지 않게)", async () => {
    const bucket = fakeBucket();
    const store = new S3SnapshotStore(bucket.sender, "site");
    await store.putFile("data/manifest.json", "{}", "x");
    await expect(store.deleteVersion("")).rejects.toThrow("버전 형식 오류");
    expect(bucket.objects.size).toBe(1);
  });

  it("deleteVersion: 일부를 못 지우면 던짐", async () => {
    const store = new S3SnapshotStore(
      {
        send: (async (command: Command) => {
          if (command instanceof ListObjectsV2Command) {
            return { Contents: [{ Key: "data/20261023T020000Z/a.json" }] };
          }
          return { Errors: [{ Key: "data/20261023T020000Z/a.json" }] };
        }) as S3Sender["send"],
      },
      "site",
    );
    await expect(store.deleteVersion("20261023T020000Z")).rejects.toThrow(
      "지우지 못함",
    );
  });
});
