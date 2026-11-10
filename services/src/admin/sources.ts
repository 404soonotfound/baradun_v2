import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { SSMClient } from "@aws-sdk/client-ssm";
import { ENDPOINTS, WEATHER_ISSUE_HOURS } from "../collectors/endpoints";
import { COLLECT_POLICY } from "../collectors/policy";
import { runLogPk } from "../core/collect/run-log";
import { RIP_SEASON_MONTHS } from "../core/rip/rip-current";
import {
  API_KEY_NAMES,
  ApiKeyMissingError,
  type ApiKeyName,
  type ApiKeyTags,
} from "../core/secrets/api-keys";
import { SsmApiKeyTags } from "../core/secrets/ssm";
import { KST_OFFSET_MS } from "../core/warnings/time";
import {
  lateAfterMinutes,
  toRunView,
  type CollectionJob,
  type RunView,
} from "./collection";
import { safeLog } from "./http";
import type { Sender } from "./writes";

// 데이터 출처 (BRD-149 ADM-SRC, 화면 V12·V13·VM13, 아키텍처 5장 수집 주기·10장 원문 저장 안 함)
// - 연결 정보(제공처·호출 주소·주기·시간 제한·받는 행 한도)는 수집기와 같은 값(collectors/endpoints·policy)을 씀
//   두 모듈은 값만 담아 운영 API 묶음에 수집기 코드가 들어가지 않음. 키·기능 이름은 sources.test.ts가 수집기 코드와 대조
// - 인증키는 등록 여부·만료일만. 값은 읽지 않음(SSM 태그만 읽는 권한, ssm:GetParameter 없음)
//   만료일은 키 파라미터의 태그 expires=YYYY-MM-DD(KST 날짜, 발급처 표기 그대로). 태그가 없거나 모양이 틀리면 null('확인 못 함')
// - 원문 응답은 저장하지 않으므로(10장) 내보내지 않음. 최근 실행 기록만
// - 해양수산부 운영 기간은 수집기가 없고 저장소 파일이 원본 → 여기 없음(화면이 따로 보여 줌)

export const KEY_READ_TIMEOUT_MS = 3_000;
// 출처별 최근 실행 수(화면 '최근 수집')
export const RECENT_RUNS = 5;
// 만료일 태그 이름
export const KEY_EXPIRES_TAG = "expires";

export type Provider = "kma" | "khoa" | "kto";

export interface SourceCall {
  readonly url: string; // 쿼리 없는 주소
  readonly operation: string; // 서비스 안 기능 이름(getPwnCd 등)
  readonly rowLimit: number | null; // 한 번에 받는 행 수(numOfRows). 없으면 null
  // 실행마다 부르지 않고 발표가 새로 나왔을 때만 부르는 호출(날씨 단기·중기). 발표 시(KST)와 발표 뒤 기다리는 분
  // null이면 실행마다 부름
  readonly issued: {
    readonly hoursKst: readonly number[];
    readonly delayMinutes: number;
  } | null;
}

export interface SourceSchedule {
  readonly periodMinutes: number;
  readonly offsetMinutes: number; // 격자 시작에서 몇 분 뒤(UTC 자정 기준)
  // 비수기에 하루 한 번만 호출(이안류). 그 시각(UTC 자정에서 몇 분 뒤)과 시즌 달
  readonly offSeason: {
    readonly slotUtcMinutes: number;
    readonly seasonMonths: readonly number[];
  } | null;
}

export interface SourceView {
  readonly id: CollectionJob;
  readonly provider: Provider;
  readonly key: ApiKeyName;
  readonly judgment: boolean; // 판단에 쓰는 출처(실패하면 앱 표시가 바뀜)
  readonly calls: readonly SourceCall[];
  readonly schedule: SourceSchedule;
  // 한 실행에서 새 요청을 보내지 않는 시간(ms). 남은 곳은 다음 실행이 받음. 없으면 null
  readonly budgetMs: number | null;
  // 같은 실행에서 일시 오류 곳을 다시 받는 상한(날씨). 없으면 null
  readonly extraRetryMax: number | null;
  readonly lateAfterMinutes: number | null;
  // 최신 먼저. 읽지 못하면 null('기록 없음'과 나눔)
  readonly recentRuns: readonly RunView[] | null;
  // 최근 기록 중 모양이 틀려 읽지 못한 수. 버리지 않고 알림(최신 실패가 빠져 정상처럼 보이지 않게)
  readonly unreadableRuns: number;
}

// 모든 출처가 같이 쓰는 HTTP 시도 정책(COLLECT_POLICY)
export interface HttpPolicy {
  readonly timeoutMs: number;
  readonly retries: number;
}

// registered: 키 파라미터가 있음 · missing: 없음 · unknown: 확인 못 함(권한·시간 초과·오류)
export type KeyStatus = "registered" | "missing" | "unknown";

export interface KeyView {
  readonly name: ApiKeyName;
  readonly status: KeyStatus;
  // YYYY-MM-DD(KST 날짜). 태그가 없거나 모양이 틀리거나 확인 못 하면 null
  readonly expiresOn: string | null;
  // KST 오늘에서 만료일까지 남은 날(오늘 만료 0, 지나면 음수). 만료일을 모르면 null
  readonly daysLeft: number | null;
  // 태그는 있는데 모양이 틀림(조용히 '없음'으로 보이지 않게 따로 알림)
  readonly expiresInvalid: boolean;
}

export interface SourcesView {
  readonly generatedAt: string;
  readonly sources: readonly SourceView[];
  readonly http: HttpPolicy;
  // 샘플(시연) 계정에는 운영 키 상태를 주지 않음 → 빈 배열 + true. 화면은 '확인 못 함'이 아니라 '보여 주지 않음'으로
  readonly keys: readonly KeyView[];
  readonly keysHidden: boolean;
}

const POLICY = COLLECT_POLICY;
const NO_BUDGET = { budgetMs: null, extraRetryMax: null };
const EVERY_RUN = { issued: null };
const grid = (s: { periodMinutes: number; offsetMinutes: number }) => ({
  periodMinutes: s.periodMinutes,
  offsetMinutes: s.offsetMinutes,
  offSeason: null,
});

const U = ENDPOINTS;

const WEATHER_HOURS = WEATHER_ISSUE_HOURS;

const MID_ISSUED = {
  hoursKst: WEATHER_HOURS.mid,
  delayMinutes: POLICY.weatherMidDelayMinutes,
};

type Catalog = Omit<
  SourceView,
  "recentRuns" | "lateAfterMinutes" | "unreadableRuns"
>;

export const SOURCE_CATALOG: readonly Catalog[] = [
  {
    id: "collect-warnings",
    provider: "kma",
    key: "data-go-kr",
    judgment: true,
    calls: [
      {
        url: U.pwncd,
        operation: "getPwnCd",
        rowLimit: POLICY.pwncdNumOfRows,
        ...EVERY_RUN,
      },
      {
        url: U.tsunami,
        operation: "getTsunamiMsg",
        rowLimit: POLICY.tsunamiNumOfRows,
        ...EVERY_RUN,
      },
    ],
    schedule: grid(POLICY.warningsSchedule),
    ...NO_BUDGET,
  },
  {
    id: "collect-ocean",
    provider: "kma",
    key: "kma-apihub",
    judgment: true,
    calls: [
      {
        url: `${U.oceanBase}sea_obs.php`,
        operation: "sea_obs",
        rowLimit: null,
        ...EVERY_RUN,
      },
      {
        url: `${U.oceanBase}kma_buoy.php`,
        operation: "kma_buoy",
        rowLimit: null,
        ...EVERY_RUN,
      },
    ],
    schedule: grid(POLICY.oceanSchedule),
    ...NO_BUDGET,
  },
  {
    id: "collect-rip",
    provider: "khoa",
    key: "data-go-kr",
    judgment: false,
    calls: [
      {
        url: U.rip,
        operation: "GetRipCurrentApiService",
        rowLimit: POLICY.ripNumOfRows,
        ...EVERY_RUN,
      },
    ],
    schedule: {
      ...grid(POLICY.ripSchedule),
      offSeason: {
        slotUtcMinutes: POLICY.ripOffSeasonSlotUtcMinutes,
        seasonMonths: [...RIP_SEASON_MONTHS],
      },
    },
    ...NO_BUDGET,
  },
  {
    id: "collect-weather",
    provider: "kma",
    key: "data-go-kr",
    judgment: false,
    calls: [
      {
        url: `${U.weatherShort}getUltraSrtNcst`,
        operation: "getUltraSrtNcst",
        rowLimit: POLICY.weatherNowNumOfRows,
        // 실황은 매시 받음(발표가 매시)
        issued: {
          hoursKst: WEATHER_HOURS.now,
          delayMinutes: POLICY.weatherNowDelayMinutes,
        },
      },
      {
        url: `${U.weatherShort}getVilageFcst`,
        operation: "getVilageFcst",
        rowLimit: POLICY.weatherShortNumOfRows,
        issued: {
          hoursKst: WEATHER_HOURS.short,
          delayMinutes: POLICY.weatherShortDelayMinutes,
        },
      },
      {
        url: `${U.weatherMid}getMidLandFcst`,
        operation: "getMidLandFcst",
        rowLimit: POLICY.weatherMidNumOfRows,
        issued: MID_ISSUED,
      },
      {
        url: `${U.weatherMid}getMidTa`,
        operation: "getMidTa",
        rowLimit: POLICY.weatherMidNumOfRows,
        issued: MID_ISSUED,
      },
    ],
    schedule: grid(POLICY.weatherSchedule),
    budgetMs: POLICY.weatherBudgetMs,
    extraRetryMax: POLICY.weatherRetryMax,
  },
  {
    id: "collect-catalog",
    provider: "kto",
    key: "data-go-kr",
    judgment: false,
    calls: [
      {
        url: `${U.catalog}/detailImage2`,
        operation: "detailImage2",
        rowLimit: POLICY.catalogImageNumOfRows,
        ...EVERY_RUN,
      },
      {
        url: `${U.catalog}/detailCommon2`,
        operation: "detailCommon2",
        rowLimit: null,
        ...EVERY_RUN,
      },
    ],
    schedule: grid(POLICY.catalogSchedule),
    budgetMs: POLICY.catalogBudgetMs,
    extraRetryMax: null,
  },
];

// ── 인증키 태그 ──
// 읽기는 core/secrets(ApiKeyTags·SsmApiKeyTags)가 맡음. 여기서는 등록 여부·만료일로 바꿈

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function validDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(ms) && new Date(ms).toISOString().startsWith(value);
}

// KST 오늘(YYYY-MM-DD)에서 만료일까지 남은 날. 날짜끼리 비교(만료일 태그가 KST 날짜)
export function daysLeft(expiresOn: string, now: Date): number {
  const today = new Date(now.getTime() + KST_OFFSET_MS)
    .toISOString()
    .slice(0, 10);
  return Math.round(
    (Date.parse(`${expiresOn}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) /
      86_400_000,
  );
}

async function readKey(
  reader: ApiKeyTags,
  name: ApiKeyName,
  now: Date,
  signal: AbortSignal,
): Promise<KeyView> {
  try {
    const tags = await reader.tags(name, signal);
    const raw = tags.find((t) => t.Key === KEY_EXPIRES_TAG)?.Value?.trim();
    const ok = raw !== undefined && validDate(raw);
    return {
      name,
      status: "registered",
      expiresOn: ok ? raw : null,
      daysLeft: ok ? daysLeft(raw, now) : null,
      expiresInvalid: raw !== undefined && !ok,
    };
  } catch (error) {
    if (signal.aborted) return unknownKey(name);
    if (error instanceof ApiKeyMissingError) {
      return { ...unknownKey(name), status: "missing" };
    }
    // 권한(boundary 미반영 등)·오류가 '확인 못 함'으로만 보이고 원인이 묻히지 않게 이름만 남김
    safeLog("warn", "ops_sources_key_read_failed", {
      key: name,
      error: errorName(error),
    });
    return unknownKey(name);
  }
}

const unknownKey = (name: ApiKeyName): KeyView => ({
  name,
  status: "unknown",
  expiresOn: null,
  daysLeft: null,
  expiresInvalid: false,
});

const errorName = (error: unknown): string =>
  error instanceof Error ? error.name : "unknown";

// 제한 시간을 넘거나 읽는 도구가 없으면 '확인 못 함'(등록 안 됨으로 보지 않음)
// 제한 시간은 키마다 따짐 → 먼저 읽힌 키는 결과를 버리지 않음. 넘으면 남은 요청을 취소함
export async function readKeys(
  reader: ApiKeyTags | null,
  now: Date,
  timeoutMs = KEY_READ_TIMEOUT_MS,
): Promise<KeyView[]> {
  if (!reader) return API_KEY_NAMES.map(unknownKey);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve();
    }, timeoutMs);
  });
  try {
    return await Promise.all(
      API_KEY_NAMES.map((name) =>
        Promise.race([
          readKey(reader, name, now, controller.signal),
          expired.then(() => unknownKey(name)),
        ]),
      ),
    );
  } finally {
    clearTimeout(timer);
  }
}

// 운영 Lambda에서 쓰는 실제 읽기(core/secrets/ssm.ts의 태그 읽기)
export function ssmKeyTagReader(region: string): ApiKeyTags {
  return new SsmApiKeyTags(new SSMClient({ region, maxAttempts: 2 }));
}

// ── 최근 실행 ──

async function recentRuns(
  client: Sender,
  opsTable: string,
  job: CollectionJob,
): Promise<{ runs: RunView[]; unreadable: number } | null> {
  try {
    const result = await client.send(
      new QueryCommand({
        TableName: opsTable,
        KeyConditionExpression: "pk = :pk",
        ProjectionExpression:
          "startedAt, finishedAt, #status, failures, missingStations, missingStationsTotal",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":pk": runLogPk(job) },
        ScanIndexForward: false,
        Limit: RECENT_RUNS,
      }),
    );
    // 상태 칸이 틀린 기록은 toRunView가 실패로 바꿔 줌. 시각이 없어 바꾸지도 못한 기록은 수를 셈(버린 채 숨기지 않음)
    const parsed = ((result.Items ?? []) as Record<string, unknown>[]).map(
      toRunView,
    );
    const runs = parsed.filter((run): run is RunView => run !== null);
    return { runs, unreadable: parsed.length - runs.length };
  } catch (error) {
    safeLog("warn", "ops_sources_runs_read_failed", {
      job,
      error: errorName(error),
    });
    return null;
  }
}

export async function readSources(
  client: Sender,
  opsTable: string,
  now: Date,
  keyReader: ApiKeyTags | null,
  options: { readonly hideKeys?: boolean } = {},
): Promise<SourcesView> {
  const hideKeys = options.hideKeys === true;
  const [keys, runs] = await Promise.all([
    hideKeys ? Promise.resolve([]) : readKeys(keyReader, now),
    Promise.all(
      SOURCE_CATALOG.map((source) => recentRuns(client, opsTable, source.id)),
    ),
  ]);
  return {
    generatedAt: now.toISOString(),
    sources: SOURCE_CATALOG.map((source, i) => ({
      ...source,
      // 이안류 비수기는 지연 표시 없음(수집 현황과 같은 기준)
      lateAfterMinutes: lateAfterMinutes(source.id, now.getTime()),
      recentRuns: runs[i]?.runs ?? null,
      unreadableRuns: runs[i]?.unreadable ?? 0,
    })),
    http: { timeoutMs: POLICY.httpTimeoutMs, retries: POLICY.httpRetries },
    keys,
    keysHidden: hideKeys,
  };
}
