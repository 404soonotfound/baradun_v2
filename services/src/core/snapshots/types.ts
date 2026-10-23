// 게시 파일 저장소 인터페이스 (BRD-61, 아키텍처 6.2·17.2)
// 게시 순서·검증은 이 인터페이스만 씀. S3 호출은 구현 한 곳에만 둠(17.2 이식성)
// 경로는 버킷 안 key(앞 / 없음). 예: data/manifest.json, data/20261017T053000Z/status.json

export interface SnapshotStore {
  // 같은 경로가 있으면 덮어씀. cacheControl은 그대로 Cache-Control 헤더가 됨
  putFile(path: string, body: string, cacheControl: string): Promise<void>;
  // 없으면 null
  getFile(path: string): Promise<string | null>;
  // data/ 아래 버전 경로 이름(snapshotVersion 형식만). 오름차순
  listVersions(): Promise<string[]>;
  // 그 버전 경로의 파일을 모두 지움
  deleteVersion(version: string): Promise<void>;
}
