import type { WarningLevel } from "@baradun/contracts";
import type { WarningKind } from "./codes";
import { parseKstTime } from "./time";

// getTsunamiMsg(기상청_지진정보 조회서비스) 정규화
// 지진해일은 getPwnCd에 없어서 여기서 받음(결정 기록 11장 10/20)

// 원본 행. data.go.kr JSON은 같은 항목을 숫자나 문자열로 줄 수 있어 값 타입을 정하지 않음
export type TsunamiItem = Record<string, unknown>;

export type TsunamiEvent = {
  source: "getTsunamiMsg";
  agency: "기상청";
  stationId: string | null; // stnId
  publishedAt: string | null; // tmFc
  seq: null; // 발표번호로 순서를 정하지 않음
  action: "issue" | "release" | null;
  kind: WarningKind; // 항상 지진해일
  level: WarningLevel | null; // 해제는 null
  zone: { kind: "text"; raw: string }; // reg. 한국어 글 그대로, 해석하지 않음
  effectiveFrom: string | null; // tmEf
  announcement: string | null; // ann 원문
  remark: string | null; // rem 원문
  unknownReasons: string[];
  raw: TsunamiItem; // 진앙 정보 등은 여기에만 둠
};

// 응답 단위 결과. 실패를 '없음'으로 읽지 않도록 셋을 나눔
export type TsunamiResult =
  | { status: "none" } // 03 NO_DATA: 지진해일 발표 없음 확인
  | { status: "ok"; events: TsunamiEvent[] } // 00: 목록
  | { status: "failed"; reason: string }; // 그 밖의 코드·형식 오류: 조회 실패

// fcTp(통보문 종류) → 동작·단계
const FC_TYPES = {
  "1": { action: "issue", level: "advisory" }, // 지진해일 주의보 발표
  "2": { action: "issue", level: "warning" }, // 지진해일 경보 발표
  "3": { action: "release", level: null }, // 해제
} as const;

// 값을 문자열로. 없음(undefined·null) → null, 숫자 → 문자열, 그 밖(객체 등) → JSON 글자로 사유에 쓰게 함
function text(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return JSON.stringify(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeTsunamiItem(item: TsunamiItem): TsunamiEvent {
  const reasons: string[] = [];

  // 시각 항목 해석. 없거나 잘못되면 null + 사유
  const time = (key: string): string | null => {
    const raw = text(item[key]) ?? "";
    const parsed = parseKstTime(raw);
    if (parsed.kind === "time") return parsed.iso;
    reasons.push(`${key}:${raw}`);
    return null;
  };

  const publishedAt = time("tmFc");

  const fcTp = text(item.fcTp) ?? "";
  const known = Object.hasOwn(FC_TYPES, fcTp)
    ? FC_TYPES[fcTp as keyof typeof FC_TYPES]
    : null;
  if (!known) reasons.push(`fcTp:${fcTp}`);

  const effectiveFrom = time("tmEf");

  const reg = text(item.reg) ?? "";
  if (reg.trim() === "") reasons.push(`reg:${reg}`);

  return {
    source: "getTsunamiMsg",
    agency: "기상청",
    stationId: text(item.stnId) || null,
    publishedAt,
    seq: null,
    action: known?.action ?? null,
    kind: { group: "judged", type: "tsunami" },
    level: known?.level ?? null,
    zone: { kind: "text", raw: reg },
    effectiveFrom,
    announcement: text(item.ann),
    remark: text(item.rem),
    unknownReasons: reasons,
    raw: item,
  };
}

// 응답 전체(JSON.parse 결과) + 요청에 쓴 numOfRows 정규화
// 모양: { response: { header: { resultCode }, body: { items: { item } } } }
export function normalizeTsunamiResponse(
  json: unknown,
  numOfRows: number,
): TsunamiResult {
  // 요청 값은 수집기가 정함 → 잘못되면 코드 오류라 멈춤(getPwnCd와 같음)
  if (!Number.isSafeInteger(numOfRows) || numOfRows < 1) {
    throw new RangeError(`numOfRows 오류: ${numOfRows}`);
  }

  const response = isObject(json) ? json.response : undefined;
  const header = isObject(response) ? response.header : undefined;
  if (!isObject(response) || !isObject(header)) {
    return { status: "failed", reason: "format:header" };
  }

  const code = text(header.resultCode);
  // '없음 확인'은 정확히 "03"일 때만. 다른 표기는 실패 쪽으로 둬 없음으로 잘못 읽지 않게 함
  if (code === "03") return { status: "none" };
  // 00이 정상. 활용가이드 예제는 "0"으로 적혀 있어 둘 다 받음
  if (code !== "00" && code !== "0") {
    return { status: "failed", reason: `resultCode:${code ?? ""}` };
  }

  const body = response.body;
  const items = isObject(body) ? body.items : undefined;
  const item = isObject(items) ? items.item : undefined;
  // 행이 여러 개면 배열, 한 개면 객체로 옴 → 배열로 맞춤
  const list = Array.isArray(item) ? item : isObject(item) ? [item] : null;
  if (!list || !list.every(isObject)) {
    return { status: "failed", reason: "format:items" };
  }
  // 요청한 만큼 꽉 찼으면 뒤 발표·해제가 잘렸을 수 있음 → 실패(getPwnCd와 같음)
  if (list.length >= numOfRows) {
    return { status: "failed", reason: `truncated:${list.length}` };
  }
  return { status: "ok", events: list.map(normalizeTsunamiItem) };
}
