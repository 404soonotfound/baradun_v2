// 운영 정책 화면의 정책 원본 (#335, 화면 설계서 6장 ADM-POL, 결정 기록 D20-8~11·D16-E5)
// 원본은 노션 '운영 정책 · 원본'. 로컬 도구(tools/ops-policy/fetch.mjs)가 받아 src/content/ops-policy.json으로 두고 PR로 반영함
// 빌드 때 서버 컴포넌트(페이지)가 이 함수로 다시 확인함. 모양이 틀리면 조용히 빼지 않고 빌드를 멈춤
// 운영 데이터가 아니라 공개 저장소에 둔 규칙 문서라 화면 묶음에 넣어도 새로 드러나는 것이 없음

export interface PolicyRun {
  text: string;
  bold?: true;
  code?: true;
}

export interface PolicySection {
  number: number;
  title: string;
  // 원본이 쓴 표시 그대로(지금은 모두 '확정'). 미확정 부분은 줄 안에 '미확정:'으로 들어 있음
  status: "확정" | "초안";
  items: PolicyRun[][];
  basis: string;
}

export interface PolicySnapshot {
  schema: 1;
  source: { title: string; url: string };
  // 노션 페이지 마지막 수정 시각(UTC ISO)
  revision: string;
  // 이 파일을 가져온 시각(UTC ISO). 가져오기가 실패하면 파일을 쓰지 않으므로 옛 시각이 그대로 남음
  fetchedAt: string;
  sections: PolicySection[];
}

export const SECTION_COUNT = 9;
const MIN_ITEMS = 3;
const MAX_ITEMS = 6;
const STATUSES = new Set(["확정", "초안"]);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const NOTION_URL = /^https:\/\/app\.notion\.com\/p\/[0-9a-f]{32}$/;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isIso = (v: unknown): v is string =>
  typeof v === "string" && ISO.test(v) && !Number.isNaN(Date.parse(v));

const nonEmpty = (v: unknown): v is string =>
  typeof v === "string" && v.trim() !== "";

function parseRun(raw: unknown, where: string): PolicyRun {
  if (!isRecord(raw) || typeof raw.text !== "string") {
    throw new Error(`${where}: 글자 조각 모양이 달라요`);
  }
  const keys = Object.keys(raw).filter((k) => k !== "text");
  if (keys.some((k) => (k !== "bold" && k !== "code") || raw[k] !== true)) {
    throw new Error(`${where}: 모르는 꾸밈이 있어요`);
  }
  const run: PolicyRun = { text: raw.text };
  if (raw.bold === true) run.bold = true;
  if (raw.code === true) run.code = true;
  return run;
}

function parseSection(raw: unknown, index: number): PolicySection {
  const where = `운영 정책 ${index + 1}번`;
  if (!isRecord(raw)) throw new Error(`${where}: 모양이 달라요`);
  if (raw.number !== index + 1) throw new Error(`${where}: 번호가 맞지 않아요`);
  if (!nonEmpty(raw.title)) throw new Error(`${where}: 제목이 없어요`);
  if (typeof raw.status !== "string" || !STATUSES.has(raw.status)) {
    throw new Error(`${where}: 확정·초안 표시가 없어요`);
  }
  // 항목마다 3~6줄(D20-10). 가져오기 도구와 같은 조건으로 손으로 고친 파일도 막음
  if (
    !Array.isArray(raw.items) ||
    raw.items.length < MIN_ITEMS ||
    raw.items.length > MAX_ITEMS
  ) {
    throw new Error(`${where}: 내용이 ${MIN_ITEMS}~${MAX_ITEMS}줄이 아니에요`);
  }
  const items = raw.items.map((item, i) => {
    if (!Array.isArray(item))
      throw new Error(`${where} ${i + 1}줄: 모양이 달라요`);
    const runs = item.map((run) => parseRun(run, `${where} ${i + 1}줄`));
    if (
      runs
        .map((r) => r.text)
        .join("")
        .trim() === ""
    ) {
      throw new Error(`${where} ${i + 1}줄: 비어 있어요`);
    }
    return runs;
  });
  if (!nonEmpty(raw.basis)) throw new Error(`${where}: 근거가 없어요`);
  return {
    number: raw.number,
    title: raw.title,
    status: raw.status as PolicySection["status"],
    items,
    basis: raw.basis,
  };
}

export function parsePolicySnapshot(raw: unknown): PolicySnapshot {
  if (!isRecord(raw) || raw.schema !== 1) {
    throw new Error("운영 정책 파일 모양(schema)이 달라요");
  }
  const source = raw.source;
  if (
    !isRecord(source) ||
    !nonEmpty(source.title) ||
    typeof source.url !== "string" ||
    !NOTION_URL.test(source.url)
  ) {
    throw new Error("운영 정책 원문 주소가 달라요");
  }
  if (!isIso(raw.revision) || !isIso(raw.fetchedAt)) {
    throw new Error("운영 정책 revision·가져온 시각이 UTC ISO 시각이 아니에요");
  }
  if (Date.parse(raw.revision) > Date.parse(raw.fetchedAt)) {
    throw new Error("운영 정책 revision이 가져온 시각보다 늦어요");
  }
  if (!Array.isArray(raw.sections) || raw.sections.length !== SECTION_COUNT) {
    throw new Error(`운영 정책 항목이 ${SECTION_COUNT}개가 아니에요`);
  }
  return {
    schema: 1,
    source: { title: source.title, url: source.url },
    revision: raw.revision,
    fetchedAt: raw.fetchedAt,
    sections: raw.sections.map(parseSection),
  };
}

// 화면 시각(KST, 연도 포함). 원본은 몇 달~몇 년 묵을 수 있어 연도 없이 보이면 오래된 동기화가 최신처럼 읽힘(D16-E5)
export function policyTime(iso: string): string {
  const parts = new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}/${get("month")}/${get("day")} ${get("hour")}:${get("minute")}`;
}

// 운영 정책 머리 한 줄용 짧은 시각(KST, MM/DD HH:MM)
export function policyShortTime(iso: string): string {
  const parts = new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("month")}/${get("day")} ${get("hour")}:${get("minute")}`;
}

// 주소 ?id= 를 항목 번호로. 숫자가 아니거나 범위 밖이면 null(화면이 '찾는 항목 없음'으로 보여 줌)
export function sectionOf(
  snapshot: PolicySnapshot,
  id: string | null,
): PolicySection | null {
  if (id === null || !/^[1-9]\d*$/.test(id)) return null;
  return snapshot.sections.find((s) => s.number === Number(id)) ?? null;
}
