import type { SnapshotStore } from "./types";

// 메모리 게시 저장소. 테스트와 로컬 실행용
// failOn: 이 경로 쓰기를 실패시킴(업로드 중 실패 시험용)

const VERSION_PATH = /^data\/([0-9]{8}T[0-9]{6}Z)\//;

export interface StoredFile {
  readonly body: string;
  readonly cacheControl: string;
}

export class MemorySnapshotStore implements SnapshotStore {
  readonly files = new Map<string, StoredFile>();

  constructor(
    private readonly failOn: (path: string) => boolean = () => false,
  ) {}

  async putFile(path: string, body: string, cacheControl: string) {
    if (this.failOn(path)) throw new Error(`쓰기 실패(시험): ${path}`);
    this.files.set(path, { body, cacheControl });
  }

  async getFile(path: string) {
    return this.files.get(path)?.body ?? null;
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
