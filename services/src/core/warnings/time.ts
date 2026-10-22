// 기상청 시각 문자열(KST yyyymmddHHMM, 예 "202610140200") → UTC ISO 문자열("…Z")
// 결과는 셋으로 나눔: 시각 / 값 없음("0"·빈 값) / 잘못된 값(원문 보관, 부르는 쪽이 unknown 처리)
export type KstTime =
  | { kind: "time"; iso: string }
  | { kind: "none" }
  | { kind: "invalid"; raw: string };

// KST = UTC+9, 서머타임 없음 → 고정 9시간 차이
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

// 정확히 숫자 12자리. 괄호 묶음 하나가 연·월·일·시·분
const PATTERN = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/;

export function parseKstTime(raw: string): KstTime {
  if (raw === "0" || raw === "") return { kind: "none" };

  const match = PATTERN.exec(raw);
  if (!match) return { kind: "invalid", raw };
  const [year, month, day, hour, minute] = match.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59) {
    return { kind: "invalid", raw };
  }

  // Date.UTC: 달은 0부터 셈. 넘치는 값은 다음 달로 넘김(2월 30일 → 3월 2일)
  // → 만든 날짜를 다시 읽어 입력과 다르면 달력에 없는 날짜로 봄. 0~99년은 1900년대로 바뀌어 같은 이유로 걸러짐
  const asUtc = new Date(Date.UTC(year, month - 1, day, hour, minute));
  if (
    asUtc.getUTCFullYear() !== year ||
    asUtc.getUTCMonth() !== month - 1 ||
    asUtc.getUTCDate() !== day
  ) {
    return { kind: "invalid", raw };
  }

  // KST 벽시계를 UTC로 읽은 값에서 9시간을 빼면 실제 UTC 시각
  // toISOString은 밀리초(".000Z")까지 붙임 → 초 단위로 자름
  const iso = new Date(asUtc.getTime() - KST_OFFSET_MS)
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z");
  return { kind: "time", iso };
}

// UTC ISO 문자열("…Z", 밀리초는 있어도 됨) → 밀리초. KST·시간대 없는 값·달력에 없는 날짜는 null
// Date.parse는 시간대 없는 값을 실행 환경 시간대로 읽음 → 형식을 먼저 확인
const UTC_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;

export function parseUtcIso(iso: string): number | null {
  if (!UTC_ISO.test(iso)) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  // Date.parse는 넘치는 날짜를 다음 달로 넘김(2월 30일 → 3월 2일)
  // → 다시 글자로 바꿔 초까지(앞 19자) 원문과 다르면 달력에 없는 날짜로 봄
  const back = new Date(ms).toISOString();
  return back.slice(0, 19) === iso.slice(0, 19) ? ms : null;
}
