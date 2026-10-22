import { WARNING_POLICY } from "./policy";

// 특보 '없음' 확인이 아직 유효한지 (아키텍처 14.3, 결정 기록 11장 10/22 ②)
// lastConfirmedAt = 정상 전체 조회를 마친 서버 시각. 경계: 45분 00초 유효, 45분 01초부터 확인 못 함
// 활성 특보는 이 결과와 상관없이 유지 → 부르는 쪽(BRD-21)이 '없음'에만 씀
export type Confirmation =
  | { confirmed: true; validUntil: string } // validUntil = lastConfirmedAt + 45분
  | { confirmed: false; reason: "never" | "invalid" | "future" | "expired" };

// UTC ISO 문자열만 받음("…Z", 밀리초는 있어도 됨). KST·시간대 없는 값은 잘못된 값으로 봄
const UTC_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;

function utcMs(iso: string): number | null {
  if (!UTC_ISO.test(iso)) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  // Date.parse는 넘치는 날짜를 다음 달로 넘김(2월 30일 → 3월 2일)
  // → 다시 글자로 바꿔 초까지(앞 19자) 원문과 다르면 달력에 없는 날짜로 봄
  const back = new Date(ms).toISOString();
  return back.slice(0, 19) === iso.slice(0, 19) ? ms : null;
}

export function checkConfirmation(
  lastConfirmedAt: string | null,
  now: string,
  ttlMs: number = WARNING_POLICY.confirmationTtlMs,
): Confirmation {
  // 기준 시각은 서버가 정함 → 잘못되면 데이터 문제가 아니라 코드 오류라 멈춤
  const nowMs = utcMs(now);
  if (nowMs === null) throw new RangeError(`기준 시각 형식 오류: ${now}`);

  // 한 번도 정상 전체 확인을 못 함
  if (lastConfirmedAt === null) return { confirmed: false, reason: "never" };

  // 저장된 값이 깨짐 → '없음'을 믿을 근거가 없음
  const lastMs = utcMs(lastConfirmedAt);
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
