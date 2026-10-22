import { gunzipSync, gzipSync } from "node:zlib";

// 특보 원본 행 묶음 저장 형식 (10/22 사용자 결정, BRD-56)
// getPwnCd 59일 응답은 JSON 그대로 642KB(실측 2,622행)라 DynamoDB 항목 한도 400KB를 넘음
// → 원본 행 배열을 gzip + base64 글자로 State에 둠(실측 37KB). publisher가 풀어 기존 정규화·판정을 그대로 씀
// 원본을 두므로 규칙이 바뀌어도 다시 계산할 수 있음

// 항목 하나의 다른 칸(키·시각 등)을 남겨 둘 여유를 빼고 잡은 상한. 넘으면 저장하지 않고 실패로 기록
export const MAX_ARCHIVE_CHARS = 300_000;

export type PackResult =
  { status: "ok"; archive: string } | { status: "failed"; reason: string };

export type UnpackResult =
  { status: "ok"; items: unknown[] } | { status: "failed"; reason: string };

export function packItems(items: readonly unknown[]): PackResult {
  const archive = gzipSync(Buffer.from(JSON.stringify(items), "utf8")).toString(
    "base64",
  );
  if (archive.length > MAX_ARCHIVE_CHARS) {
    return { status: "failed", reason: `archive_too_large:${archive.length}` };
  }
  return { status: "ok", archive };
}

// 깨진 글자·압축 오류·배열이 아닌 내용은 실패. 빈 배열로 바꾸지 않음(빈 목록은 '특보 없음'처럼 읽힐 수 있음)
export function unpackItems(archive: string): UnpackResult {
  try {
    const json: unknown = JSON.parse(
      gunzipSync(Buffer.from(archive, "base64")).toString("utf8"),
    );
    if (!Array.isArray(json)) return { status: "failed", reason: "not_array" };
    return { status: "ok", items: json };
  } catch {
    return { status: "failed", reason: "corrupt" };
  }
}
