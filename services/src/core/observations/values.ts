// 관측 값 검사 (결정 기록 11장 10/22 BRD-19)
// 원문 글자 하나 → 쓸 수 있는 숫자, 못 쓰면 null(무효)
// 근거 없는 상한은 두지 않음. 아래 규칙만 검사

// 지표 이름. 공개 계약 Beach.stations·observation.metrics의 키와 같음
// type A = "x" | "y": 이 다섯 글자 중 하나만 들어갈 수 있는 타입(오타를 타입 검사가 잡음)
export type MetricKey =
  "waveHeight" | "wavePeriod" | "waveDirection" | "waterTemp" | "wind";

// 확인된 결측 표기. 실응답·수신 기록 44,783행에서 이 둘만 나옴
// Set: 값 모음. has()로 들어 있는지 빠르게 확인
const MISSING = new Set(["-99", "-99.0"]);

// 숫자 모양: 앞 부호(-)는 있어도 되고, 소수점 아래는 있어도 됨
// /^…$/: 처음(^)부터 끝($)까지 전체가 이 모양이어야 통과
// 1e3·0x10·빈 글자는 거부(Number()는 이런 값도 숫자로 바꿔 버림)
const NUMBER_TEXT = /^-?\d+(\.\d+)?$/;

// 지표별 쓸 수 있는 값인지. 결측 표기는 이보다 먼저 거름
// Record<MetricKey, …>: 다섯 지표 모두 빠짐없이 있어야 하는 객체(하나라도 빠지면 타입 오류)
// (value) => value >= 0: 숫자를 받아 참·거짓을 돌려주는 짧은 함수(화살표 함수)
const VALID: Record<MetricKey, (value: number) => boolean> = {
  waveHeight: (value) => value >= 0, // 음수 무효, 0.0은 정상값
  wind: (value) => value >= 0, // 풍속(m/s). 음수 무효, 0.0은 정상값
  wavePeriod: (value) => value > 0, // 0초는 물리적으로 없음 → 0 이하 무효
  waveDirection: (value) => value >= 0 && value <= 360, // 0~360° 밖 무효(실응답 -1)
  waterTemp: () => true, // 영하 수온도 정상(측정범위 -2~+40°C). 결측 표기만 거름
};

// export: 다른 파일에서 import로 쓸 수 있게 내보냄
// 반환 타입 number | null: 숫자 또는 null 둘 중 하나
export function readMetricValue(key: MetricKey, raw: string): number | null {
  const text = raw.trim(); // 앞뒤 빈칸 지움(응답은 칸을 빈칸으로 맞춰 줌)
  // ||: 둘 중 하나라도 참이면 참. !: 참·거짓 뒤집기
  if (MISSING.has(text) || !NUMBER_TEXT.test(text)) return null;
  const value = Number(text); // 모양을 확인한 뒤에만 숫자로 바꿈
  // 조건 ? A : B → 조건이 참이면 A, 거짓이면 B
  return VALID[key](value) ? value : null;
}
