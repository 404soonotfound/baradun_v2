import { normalizePwnCdRow, type PwnCdRow, type PwnEvent } from "./normalize";

// getPwnCd 응답 전체 판정 (아키텍처 4장 10/22 실응답 확인, 결정 기록 11장 10/22 ⑥)
// 정상 = 00 + 받은 행 수 < 요청 numOfRows. 03·99·잘림·형식 오류는 모두 실패
// 03은 잘못된 범위·넘친 쪽에서도 나옴 → '특보 없음'으로 읽지 않음. totalCount는 실제와 달라 쓰지 않음

// 원본 행. 실응답은 tmFc·tmSeq 등이 숫자, command·areaCode 등이 글자 → 값 타입을 정하지 않음
// 응답 경계에서만 쓰는 타입. 정규화 함수에는 글자만 있는 PwnCdRow를 넘김
export type PwnCdRawItem = Record<string, unknown>;

export type PwnCdResult =
  | { status: "ok"; rowCount: number; events: PwnEvent[] } // rowCount: 잘림 대비 알림용(BRD-56)
  | { status: "failed"; reason: string };

// 꼭 있어야 하는 칸. stnId(발표 관서)는 응답에 없을 수 있어 따로 처리
const FIELDS = [
  "tmFc",
  "tmSeq",
  "areaCode",
  "areaName",
  "warnVar",
  "warnStress",
  "command",
  "cancel",
  "startTime",
  "endTime",
  "allEndTime",
] as const satisfies readonly (keyof PwnCdRow)[];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// 값 하나 → 글자. 글자는 그대로, 0 이상 정수는 글자로. 그 밖(소수·객체·없음 등)은 null
function asText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  return null;
}

// 원본 행 → 글자만 있는 행. 바꿀 수 없는 칸이 있으면 그 칸 이름을 돌려줌
function toRow(item: PwnCdRawItem): PwnCdRow | string {
  const row = {} as Record<(typeof FIELDS)[number], string>;
  for (const field of FIELDS) {
    const text = asText(item[field]);
    if (text === null) return field;
    row[field] = text;
  }
  if (item.stnId === undefined) return row;
  const stnId = asText(item.stnId);
  return stnId === null ? "stnId" : { ...row, stnId };
}

// 응답 전체(JSON.parse 결과) + 요청에 쓴 numOfRows
// 모양: { response: { header: { resultCode }, body: { items: { item } } } }
export function normalizePwnCdResponse(
  json: unknown,
  numOfRows: number,
): PwnCdResult {
  // 요청 값은 수집기가 정함 → 잘못되면 코드 오류라 멈춤
  if (!Number.isSafeInteger(numOfRows) || numOfRows < 1) {
    throw new RangeError(`numOfRows 오류: ${numOfRows}`);
  }

  const response = isObject(json) ? json.response : undefined;
  const header = isObject(response) ? response.header : undefined;
  if (!isObject(response) || !isObject(header)) {
    return { status: "failed", reason: "format:header" };
  }

  // 정상은 정확히 "00"만. 03(NO_DATA)·99 등은 모두 실패
  const code = asText(header.resultCode);
  if (code !== "00") {
    return { status: "failed", reason: `resultCode:${code ?? ""}` };
  }

  const body = response.body;
  const items = isObject(body) ? body.items : undefined;
  const item = isObject(items) ? items.item : undefined;
  // 행이 여러 개면 배열, 한 개면 객체로 옴 → 배열로 맞춤
  const list = Array.isArray(item) ? item : isObject(item) ? [item] : null;
  if (!list) return { status: "failed", reason: "format:items" };

  // 요청한 만큼 꽉 찼으면 뒤가 잘렸을 수 있음(쪽 나누기는 불안정해서 쓰지 않음)
  if (list.length >= numOfRows) {
    return { status: "failed", reason: `truncated:${list.length}` };
  }

  // 한 행이라도 형식이 틀리면 응답 전체를 믿지 않음
  const rows: PwnCdRow[] = [];
  for (const [i, raw] of list.entries()) {
    if (!isObject(raw)) {
      return { status: "failed", reason: `format:item[${i}]` };
    }
    const row = toRow(raw);
    if (typeof row === "string") {
      return { status: "failed", reason: `format:item[${i}].${row}` };
    }
    rows.push(row);
  }
  return {
    status: "ok",
    rowCount: rows.length,
    events: rows.map(normalizePwnCdRow),
  };
}
