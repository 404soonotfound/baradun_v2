// 메타 정보 한줄 (범위 -> 기관 -> 시각)

// 구분 기호
export const META_SEPARATOR = " · ";

// 공백 빼고 나머지를 순서대로 이어줌
export function joinMeta(
  parts: readonly (string | null | undefined)[],
): string | null {
  // (part): part is string = 이 검사를 통과한 값은 string이라고 타입에 알려줌(타입 좁히기)
  const kept = parts.filter(
    (part): part is string => typeof part === "string" && part.trim() !== "",
  );
  return kept.length === 0 ? null : kept.join(META_SEPARATOR);
}

// 측정소 거리 숫자 글자. 소수 한자리까지 끝에 .0음 뺌  (12.0 -> 12)
export function formatKm(km: number): string | null {
  if (!Number.isFinite(km) || km < 0) return null;
  return String(Math.round(km * 10) / 10);
}
