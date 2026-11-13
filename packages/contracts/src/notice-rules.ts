// 공지 문구 규칙 (BRD-151). 운영 API(services)와 운영자 화면(apps/admin)이 함께 씀
// 입구(index.ts)와 달리 실행 코드라 '@baradun/contracts/notice-rules'로 따로 가져옴 → 공개 웹 번들에는 들어가지 않음

// 노출 전 글자 수 상한(grapheme 기준, D16-D2 초기값을 D20-20에서 확정)
// 넘으면 잘라 내지 않고 노출을 막음
export const NOTICE_TEXT_MAX = {
  title: { ko: 40, en: 60 },
  body: { ko: 120, en: 200 },
} as const;

// 초안 저장 상한(글자). 노출 상한과 별개로 요청 크기만 막음
export const NOTICE_DRAFT_TEXT_MAX = 1000;

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function graphemeLength(text: string): number {
  let count = 0;
  for (const _ of segmenter.segment(text)) count += 1;
  return count;
}

// ---- 표현 검사 (D16-D1 원칙, 결정 기록 D17-8 목록 · 2026-11-05 확정) ----
// - 초안 저장은 막지 않음. 차단 표현은 노출(게시 대상 확정)을 막고, 경고 표현은 알리기만 함
// - 단어가 아니라 표현 단위: NFKC·소문자로 맞추고 띄어쓰기를 지운 뒤 비교
// - 허용 표현과 겹치는 자리는 먼저 뺌('안전요원 안내'의 '안전'은 경고하지 않음)
// - 영문 표현은 단어 경계에서만 맞춤('operating' 안의 'rating'을 막지 않음)
// - ○는 숫자 한 자리 이상

export const NOTICE_BLOCKED_PHRASES = {
  // 안전 보장
  guarantee: [
    "안전해요",
    "안전합니다",
    "안전을 보장",
    "위험 없음",
    "안심하고",
    "마음 놓고",
    "safe to swim",
    "guaranteed safe",
    "no risk",
    "risk-free",
  ],
  // 이용 판단(G2)
  judgment: [
    "입수 가능",
    "수영 가능",
    "출입 가능",
    "통제 없음",
    "OK to swim",
    "open to swim",
    "no restrictions",
  ],
  // 근거 없는 추천
  recommend: [
    "추천 해변",
    "추천해요",
    "추천합니다",
    "강력 추천",
    "최고의 해변",
    "베스트 해변",
    "recommended",
    "best beach",
    "top pick",
  ],
  // 점수
  score: [
    "적합도",
    "별점",
    "○점",
    "○위",
    "TOP ○",
    "suitability",
    "rating",
    "score",
    "ranked",
  ],
} as const;

export type NoticePhraseCategory = keyof typeof NOTICE_BLOCKED_PHRASES;

// 문맥 확인(경고만)
export const NOTICE_WARNED_PHRASES = [
  "안전",
  "위험",
  "괜찮아요",
  "적합",
  "잔잔해요",
  "최적",
  "물놀이하기 좋은",
  "safe",
  "suitable",
  "calm",
  "ideal",
  "perfect",
] as const;

// 검사 제외
export const NOTICE_ALLOWED_PHRASES = [
  "안전요원",
  "안전수칙",
  "안전·데이터 안내",
  "안전을 보장하지 않아요",
  "lifeguard",
  "safety guidelines",
  "not a safety guarantee",
] as const;

// D17-8 목록 밖: 점검 예고의 '04:00 점검'·'특별 점검'이 띄어쓰기를 지우면 '○점'·'별점'과 겹쳐 막히지 않게 뺌
// 붙여 쓴 '점검'만 뺌. '5점 검증'·'별점 검토'처럼 '점'과 '검' 사이를 띄운 자리는 그대로 막음
const MAINTENANCE = "점검";

export interface NoticePhraseHit {
  // 목록의 표현(예: '○점')
  readonly phrase: string;
  // 문구에서 실제로 맞은 부분(예: '5점')
  readonly text: string;
}

export interface NoticeBlockedHit extends NoticePhraseHit {
  readonly category: NoticePhraseCategory;
}

export interface NoticePhraseResult {
  readonly blocked: readonly NoticeBlockedHit[];
  readonly warned: readonly NoticePhraseHit[];
}

interface Rule {
  readonly phrase: string;
  readonly pattern: RegExp;
  // 앞·뒤가 영문·숫자면 단어 경계를 확인
  readonly edgeStart: boolean;
  readonly edgeEnd: boolean;
}

const WORD = /[\p{Script=Latin}0-9]/u;
// 띄어쓰기·보이지 않는 서식 문자(폭 없는 공백·soft hyphen 등 \p{Cf})·이음표(하이픈·가운뎃점·#·_·*)는 지우고 비교
// 'safe-to-swim'·'TOP-5'·'추천·해변'·폭 없는 공백으로 차단 표현이 빠져나가지 않게 함
const SEPARATOR = /[\s\p{Cf}\p{Pd}·・•_#*]/u;

function squash(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\p{Cf}\p{Pd}·・•_#*]+/gu, "");
}

function rule(phrase: string): Rule {
  const squashed = squash(phrase);
  const source = squashed
    .split("○")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&"))
    .join("\\d+");
  const first = squashed[0] ?? "";
  const last = squashed.at(-1) ?? "";
  // 영문 낱말로 끝나는 표현은 복수형(-s·-es)도 같은 표현으로 봄('best beaches'·'ratings')
  const plural = /\p{Script=Latin}/u.test(last) ? "(?:e?s)?" : "";
  return {
    phrase,
    pattern: new RegExp(`(${source})${plural}`, "gu"),
    edgeStart: first === "○" || WORD.test(first),
    edgeEnd: last === "○" || WORD.test(last),
  };
}

const ALLOWED = NOTICE_ALLOWED_PHRASES.map(rule);
const MAINTENANCE_RULE = rule(MAINTENANCE);
const WARNED = NOTICE_WARNED_PHRASES.map(rule);
const BLOCKED = (
  Object.entries(NOTICE_BLOCKED_PHRASES) as [
    NoticePhraseCategory,
    readonly string[],
  ][]
).flatMap(([category, phrases]) =>
  phrases.map((phrase) => ({ category, ...rule(phrase) })),
);

interface Span {
  readonly from: number;
  readonly to: number;
}

const overlaps = (a: Span, b: Span) => a.from < b.to && b.from < a.to;

export function checkNoticePhrases(text: string): NoticePhraseResult {
  // 띄어쓰기를 지운 문자열(squashed)의 각 자리 → 원래 문자열(source)의 시작·끝 위치
  const source = text.normalize("NFKC");
  let squashed = "";
  const starts: number[] = [];
  const ends: number[] = [];
  for (let i = 0; i < source.length;) {
    const char = String.fromCodePoint(source.codePointAt(i)!);
    if (!SEPARATOR.test(char)) {
      for (const unit of char.toLowerCase().split("")) {
        squashed += unit;
        starts.push(i);
        ends.push(i + char.length);
      }
    }
    i += char.length;
  }

  const find = (r: Rule): (Span & { text: string })[] => {
    const spans: (Span & { text: string })[] = [];
    // 경계에 걸려 버린 자리는 한 글자 뒤에서 다시 찾음('v2 5점'의 '25점'을 버린 뒤 '5점'을 찾게)
    // 복수형 접미사를 붙인 길이가 경계에 걸리면 접미사 없는 길이도 봄('calm sea'의 'calms'가 아닌 'calm')
    const pattern = new RegExp(r.pattern.source, "gu");
    for (
      let match = pattern.exec(squashed);
      match;
      match = pattern.exec(squashed)
    ) {
      const from = match.index;
      const before = source[starts[from]! - 1] ?? "";
      const to = [from + match[0].length, from + match[1]!.length].find(
        (end) => !(r.edgeEnd && WORD.test(source[ends[end - 1]!] ?? "")),
      );
      if ((r.edgeStart && WORD.test(before)) || to === undefined) {
        pattern.lastIndex = from + 1;
        continue;
      }
      spans.push({ from, to, text: source.slice(starts[from], ends[to - 1]) });
      pattern.lastIndex = to;
    }
    return spans;
  };

  const allowed = [
    ...ALLOWED.flatMap(find),
    ...find(MAINTENANCE_RULE).filter((span) => !SEPARATOR.test(span.text)),
  ];
  const free = (span: Span) => !allowed.some((a) => overlaps(a, span));

  const blockedSpans: Span[] = [];
  const blocked: NoticeBlockedHit[] = [];
  for (const r of BLOCKED) {
    for (const span of find(r).filter(free)) {
      blockedSpans.push(span);
      if (!blocked.some((h) => h.phrase === r.phrase && h.text === span.text)) {
        blocked.push({
          phrase: r.phrase,
          text: span.text,
          category: r.category,
        });
      }
    }
  }

  // 차단으로 이미 잡힌 자리는 경고에서 뺌('적합도' 안의 '적합')
  const warned: NoticePhraseHit[] = [];
  for (const r of WARNED) {
    for (const span of find(r)) {
      if (!free(span) || blockedSpans.some((b) => overlaps(b, span))) continue;
      if (!warned.some((h) => h.phrase === r.phrase && h.text === span.text)) {
        warned.push({ phrase: r.phrase, text: span.text });
      }
    }
  }
  return { blocked, warned };
}
