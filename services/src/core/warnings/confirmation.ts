import { WARNING_POLICY } from "./policy";
import { parseUtcIso } from "./time";

// 특보 '없음' 확인이 아직 유효한지 (아키텍처 14.3, 결정 기록 11장 10/22 ②)
// lastConfirmedAt = 정상 전체 조회를 마친 서버 시각. 경계: 45분 00초 유효, 45분 01초부터 확인 못 함
// 활성 특보는 이 결과와 상관없이 유지 → 부르는 쪽(BRD-21)이 '없음'에만 씀
export type Confirmation =
  | { confirmed: true; validUntil: string } // validUntil = lastConfirmedAt + 45분
  | { confirmed: false; reason: "never" | "invalid" | "future" | "expired" };

export function checkConfirmation(
  lastConfirmedAt: string | null,
  now: string,
  ttlMs: number = WARNING_POLICY.confirmationTtlMs,
): Confirmation {
  // UTC ISO만 받음(KST·시간대 없는 값은 잘못된 값). 기준 시각은 서버가 정함 → 잘못되면 데이터 문제가 아니라 코드 오류라 멈춤
  const nowMs = parseUtcIso(now);
  if (nowMs === null) throw new RangeError(`기준 시각 형식 오류: ${now}`);

  // 한 번도 정상 전체 확인을 못 함
  if (lastConfirmedAt === null) return { confirmed: false, reason: "never" };

  // 저장된 값이 깨짐 → '없음'을 믿을 근거가 없음
  const lastMs = parseUtcIso(lastConfirmedAt);
  if (lastMs === null) return { confirmed: false, reason: "invalid" };

  // 기준 시각보다 늦은 확인 → 시계가 어긋남. 믿지 않음
  if (lastMs > nowMs) return { confirmed: false, reason: "future" };

  // 45분을 넘었을 때만 만료. 딱 45:00은 넘지 않음 → 유효
  if (nowMs - lastMs > ttlMs) return { confirmed: false, reason: "expired" };

  const validUntil = new Date(lastMs + ttlMs)
    .toISOString()
    .replace(/\.000Z$/, "Z");
  return { confirmed: true, validUntil };
}
