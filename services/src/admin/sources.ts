import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import {
  ListTagsForResourceCommand,
  SSMClient,
  type Tag,
} from "@aws-sdk/client-ssm";
import { COLLECT_POLICY } from "../collectors/policy";
import { runLogPk } from "../core/collect/run-log";
import { RIP_SEASON_MONTHS } from "../core/rip/rip-current";
import {
  API_KEY_NAMES,
  apiKeyParameterName,
  type ApiKeyName,
} from "../core/secrets/api-keys";
import {
  lateAfterMinutes,
  toRunView,
  type CollectionJob,
  type RunView,
} from "./collection";
import { safeLog } from "./http";
import type { Sender } from "./writes";

// 데이터 출처 (BRD-149 ADM-SRC, 화면 V12·V13·VM13, 아키텍처 5장 수집 주기·10장 원문 저장 안 함)
// - 연결 정보(제공처·호출 주소·주기·시간 제한·받는 행 한도)는 수집기 코드 값을 그대로 옮김
//   운영 API 묶음에 수집기 코드를 넣지 않으려고 값만 두고, sources.test.ts가 수집기 상수와 같은지 확인함
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
  readonly timeoutMs: number;
  readonly retries: number;
  readonly lateAfterMinutes: number | null;
  // 최신 먼저. 읽지 못하면 null('기록 없음'과 나눔)
  readonly recentRuns: readonly RunView[] | null;
}

// registered: 키 파라미터가 있음 · missing: 없음 · unknown: 확인 못 함(권한·시간 초과·오류)
export type KeyStatus = "registered" | "missing" | "unknown";

export interface KeyView {
  readonly name: ApiKeyName;
  readonly status: KeyStatus;
  // YYYY-MM-DD(KST 날짜). 태그가 없거나 모양이 틀리거나 확인 못 하면 null
  readonly expiresOn: string | null;
  // 태그는 있는데 모양이 틀림(조용히 '없음'으로 보이지 않게 따로 알림)
  readonly expiresInvalid: boolean;
}

export interface SourcesView {
  readonly generatedAt: string;
  readonly sources: readonly SourceView[];
  // 샘플(시연) 계정에는 운영 키 상태를 주지 않음 → 빈 배열 + true. 화면은 '확인 못 함'이 아니라 '보여 주지 않음'으로
  readonly keys: readonly KeyView[];
  readonly keysHidden: boolean;
}

const POLICY = COLLECT_POLICY;
const RETRY = { timeoutMs: POLICY.httpTimeoutMs, retries: POLICY.httpRetries };
const grid = (s: { periodMinutes: number; offsetMinutes: number }) => ({
  periodMinutes: s.periodMinutes,
  offsetMinutes: s.offsetMinutes,
  offSeason: null,
});

// 수집기 코드의 호출 주소(sources.test.ts가 collectors/*의 상수와 같은지 확인)
export const SOURCE_URLS = {
  pwncd: "https://apis.data.go.kr/1360000/WthrWrnInfoService/getPwnCd",
  tsunami: "https://apis.data.go.kr/1360000/EqkInfoService/getTsunamiMsg",
  oceanBase: "https://apihub.kma.go.kr/api/typ01/url/",
  rip: "https://apis.data.go.kr/1192136/ripCurrent/GetRipCurrentApiService",
  weatherShort: "https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/",
  weatherMid: "https://apis.data.go.kr/1360000/MidFcstInfoService/",
  catalog: "https://apis.data.go.kr/B551011/KorService2",
} as const;

const U = SOURCE_URLS;

type Catalog = Omit<SourceView, "recentRuns" | "lateAfterMinutes">;

export const SOURCE_CATALOG: readonly Catalog[] = [
  {
    id: "collect-warnings",
    provider: "kma",
    key: "data-go-kr",
    judgment: true,
    calls: [
      { url: U.pwncd, operation: "getPwnCd", rowLimit: POLICY.pwncdNumOfRows },
      {
        url: U.tsunami,
        operation: "getTsunamiMsg",
        rowLimit: POLICY.tsunamiNumOfRows,
      },
    ],
    schedule: grid(POLICY.warningsSchedule),
    ...RETRY,
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
      },
      {
        url: `${U.oceanBase}kma_buoy.php`,
        operation: "kma_buoy",
        rowLimit: null,
      },
    ],
    schedule: grid(POLICY.oceanSchedule),
    ...RETRY,
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
      },
    ],
    schedule: {
      ...grid(POLICY.ripSchedule),
      offSeason: {
        slotUtcMinutes: POLICY.ripOffSeasonSlotUtcMinutes,
        seasonMonths: [...RIP_SEASON_MONTHS],
      },
    },
    ...RETRY,
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
      },
      {
        url: `${U.weatherShort}getVilageFcst`,
        operation: "getVilageFcst",
        rowLimit: POLICY.weatherShortNumOfRows,
      },
      {
        url: `${U.weatherMid}getMidLandFcst`,
        operation: "getMidLandFcst",
        rowLimit: POLICY.weatherMidNumOfRows,
      },
      {
        url: `${U.weatherMid}getMidTa`,
        operation: "getMidTa",
        rowLimit: POLICY.weatherMidNumOfRows,
      },
    ],
    schedule: grid(POLICY.weatherSchedule),
    ...RETRY,
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
      },
      {
        url: `${U.catalog}/detailCommon2`,
        operation: "detailCommon2",
        rowLimit: null,
      },
    ],
    schedule: grid(POLICY.catalogSchedule),
    ...RETRY,
  },
];

// ── 인증키 태그 ──

// SSM 태그 읽기를 감싼 것. 테스트는 가짜를 넣음
// 파라미터가 없으면 missing 오류를 던짐(InvalidResourceId), 그 밖의 오류는 그대로 던짐
export interface KeyTagReader {
  tags(parameterName: string): Promise<readonly Tag[]>;
}

export class KeyMissingError extends Error {}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function validDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(ms) && new Date(ms).toISOString().startsWith(value);
}

async function readKey(
  reader: KeyTagReader,
  name: ApiKeyName,
): Promise<KeyView> {
  try {
    const tags = await reader.tags(apiKeyParameterName(name));
    const raw = tags.find((t) => t.Key === KEY_EXPIRES_TAG)?.Value?.trim();
    const ok = raw !== undefined && validDate(raw);
    return {
      name,
      status: "registered",
      expiresOn: ok ? raw : null,
      expiresInvalid: raw !== undefined && !ok,
    };
  } catch (error) {
    if (error instanceof KeyMissingError) {
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
  expiresInvalid: false,
});

const errorName = (error: unknown): string =>
  error instanceof Error ? error.name : "unknown";

// 제한 시간을 넘거나 읽는 도구가 없으면 '확인 못 함'(등록 안 됨으로 보지 않음)
// 제한 시간은 키마다 따짐 → 먼저 읽힌 키는 결과를 버리지 않음
export async function readKeys(
  reader: KeyTagReader | null,
  timeoutMs = KEY_READ_TIMEOUT_MS,
): Promise<KeyView[]> {
  if (!reader) return API_KEY_NAMES.map(unknownKey);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  try {
    return await Promise.all(
      API_KEY_NAMES.map((name) =>
        Promise.race([
          readKey(reader, name),
          expired.then(() => unknownKey(name)),
        ]),
      ),
    );
  } finally {
    clearTimeout(timer);
  }
}

// 운영 Lambda에서 쓰는 실제 읽기. ListTagsForResource만(값을 돌려주는 GetParameter는 쓰지 않음)
export function ssmKeyTagReader(
  region: string,
  client = new SSMClient({ region, maxAttempts: 2 }),
): KeyTagReader {
  return {
    async tags(parameterName) {
      try {
        const result = await client.send(
          new ListTagsForResourceCommand({
            ResourceType: "Parameter",
            ResourceId: parameterName,
          }),
        );
        return result.TagList ?? [];
      } catch (error) {
        if ((error as { name?: string }).name === "InvalidResourceId") {
          throw new KeyMissingError(parameterName);
        }
        throw error;
      }
    },
  };
}

// ── 최근 실행 ──

async function recentRuns(
  client: Sender,
  opsTable: string,
  job: CollectionJob,
): Promise<RunView[] | null> {
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
    // 모양이 틀린 기록은 toRunView가 실패로 바꿔 줌(버리지 않음)
    return ((result.Items ?? []) as Record<string, unknown>[])
      .map(toRunView)
      .filter((run): run is RunView => run !== null);
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
  keyReader: KeyTagReader | null,
  options: { readonly hideKeys?: boolean } = {},
): Promise<SourcesView> {
  const hideKeys = options.hideKeys === true;
  const [keys, runs] = await Promise.all([
    hideKeys ? Promise.resolve([]) : readKeys(keyReader),
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
      recentRuns: runs[i] ?? null,
    })),
    keys,
    keysHidden: hideKeys,
  };
}
