import { formatUtcIso } from "../warnings/time";

// 게시 버전(경로 이름·게시 요약 키, 예: 20261104T051000Z). publisher와 운영 API 수집 현황이 같이 씀(BRD-187)
// 고정 길이 숫자라 글자 순서가 시각 순서와 같음
export function snapshotVersion(ms: number): string {
  return formatUtcIso(ms).replace(/[-:]/g, "");
}
