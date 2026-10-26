import type { SnapshotStore, TaggedFile } from "./types";

// 메모리 게시 저장소. 테스트와 로컬 실행용
// failOn: 이 경로 쓰기를 실패시킴(업로드 중 실패 시험용)
// beforeConditionalPut: 조건부 쓰기가 조건을 보기 직전에 부름(다른 실행이 끼어드는 순간 시험용)

const VERSION_PATH = /^data\/([0-9]{8}T[0-9]{6}Z)\//;

export interface StoredFile {
  readonly body: string;
  readonly cacheControl: string;
  readonly etag: string;
}

export interface MemorySnapshotStoreOptions {
  readonly failOn?: ((path: string) => boolean) | undefined;
  readonly beforeConditionalPut?:
    | ((path: string) => Promise<void> | void)
    | undefined;
}

export class MemorySnapshotStore implements SnapshotStore {
  readonly files = new Map<string, StoredFile>();
  private nextTag = 1;
  private readonly failOn: (path: string) => boolean;
  private readonly beforeConditionalPut: (
    path: string,
  ) => Promise<void> | void;

  // 예전 호출(new MemorySnapshotStore(failOn))도 그대로 받음
  constructor(
    options:
      | MemorySnapshotStoreOptions
      | ((path: string) => boolean) = {},
  ) {
    const opts = typeof options === "function" ? { failOn: options } : options;
    this.failOn = opts.failOn ?? (() => false);
    this.beforeConditionalPut = opts.beforeConditionalPut ?? (() => undefined);
  }

  // 쓸 때마다 새 표지. S3 ETag처럼 내용이 같아도 쓰기마다 다른 값이 되지는 않지만,
  // 시험에서는 "다른 실행이 썼다"를 확실히 구분하려고 매번 바꿈
  private store(path: string, body: string, cacheControl: string) {
    this.files.set(path, {
      body,
      cacheControl,
      etag: `"m${this.nextTag++}"`,
    });
  }

  async putFile(path: string, body: string, cacheControl: string) {
    if (this.failOn(path)) throw new Error(`쓰기 실패(시험): ${path}`);
    this.store(path, body, cacheControl);
  }

  async putFileIf(
    path: string,
    body: string,
    cacheControl: string,
    expectedEtag: string | null,
  ) {
    await this.beforeConditionalPut(path);
    if (this.failOn(path)) throw new Error(`쓰기 실패(시험): ${path}`);
    const current = this.files.get(path);
    const matches =
      expectedEtag === null
        ? current === undefined
        : current?.etag === expectedEtag;
    if (!matches) return false;
    this.store(path, body, cacheControl);
    return true;
  }

  async getFile(path: string) {
    return this.files.get(path)?.body ?? null;
  }

  async getTaggedFile(path: string): Promise<TaggedFile | null> {
    const file = this.files.get(path);
    return file ? { body: file.body, etag: file.etag } : null;
  }

  async listVersions() {
    const versions = new Set<string>();
    for (const path of this.files.keys()) {
      const match = VERSION_PATH.exec(path);
      if (match) versions.add(match[1]!);
    }
    return [...versions].sort();
  }

  async deleteVersion(version: string) {
    for (const path of [...this.files.keys()]) {
      if (path.startsWith(`data/${version}/`)) this.files.delete(path);
    }
  }
}
