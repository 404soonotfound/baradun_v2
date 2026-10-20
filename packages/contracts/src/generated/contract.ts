// 자동 생성 파일: 직접 고치지 말고 schemas/를 고친 뒤 `npm run generate`

/**
 * UTC, 예: 2026-10-17T05:30:00Z
 *
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "DateTime".
 */
export type DateTime = string;
/**
 * 점검 종료 예정. 모르면 null.
 */
export type NullableDateTime = string | null;
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "SnapshotPath".
 */
export type SnapshotPath = string;
/**
 * 내부 id. 예: b0001
 *
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "BeachId".
 */
export type BeachId = string;
/**
 * 대표 관측소. 같은 해상 특보구역 20km 안에 없으면 null → '가까운 관측 없음'.
 *
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "StationRef".
 */
export type StationRef = null | {
  id: string;
  name: LocalizedText;
  distanceKm: number;
};
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "BeachStatus".
 */
export type BeachStatus = BeachStatus1;
/**
 * 판단하는 바다 관련 특보 5종(B3): 풍랑·강풍·태풍·폭풍해일·지진해일.
 *
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "WarningType".
 */
export type WarningType = 'wind_wave' | 'strong_wind' | 'typhoon' | 'storm_surge' | 'tsunami';
/**
 * 주의보 / 경보 / 중대경보(getPwnCd warnStress 0·1·2, 10/20).
 *
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "WarningLevel".
 */
export type WarningLevel = 'advisory' | 'warning' | 'severe_warning';
/**
 * 발표 또는 관측 시각.
 */
export type NullableDateTime1 = string | null;
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "WarningState".
 */
export type WarningState = WarningState1;
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "NullableDateTime".
 */
export type NullableDateTime2 = string | null;
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "Metric".
 */
export type Metric = Metric1;
/**
 * 파고·수온·바람 observedAt + 90분, 파주기 + 60분(B4).
 */
export type NullableDateTime3 = string | null;
/**
 * 판단에 쓰지 않는 특보(B3): 호우·폭염·한파·대설·건조·황사·열대야(10/20).
 *
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "NearbyWarningType".
 */
export type NearbyWarningType =
  'heavy_rain' | 'heat_wave' | 'cold_wave' | 'heavy_snow' | 'dry' | 'yellow_dust' | 'tropical_night';
/**
 * UTC, 예: 2026-10-17T05:30:00Z
 */
export type DateTime1 = string;

/**
 * 바라던 바다 V2 공개 데이터 계약 v1 (아키텍처 6.3, 결정 기록 11장 B2). 파일마다 $defs의 *File 정의를 따름.
 */
export interface Contract {
  [k: string]: unknown;
}
/**
 * /data/manifest.json. 브라우저가 가장 먼저 받는 파일. 60초 캐시.
 *
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "ManifestFile".
 */
export interface ManifestFile {
  /**
   * 계약 버전. 화면이 지원하지 않는 값이면 새로고침 후 판단불가(아키텍처 9.1).
   */
  schemaVersion: 1;
  /**
   * 게시 버전. 예: 20261017T053000Z
   */
  snapshotVersion: string;
  /**
   * 분류 규칙 버전(지연 기준 등).
   */
  policyVersion: string;
  generatedAt: DateTime;
  maintenance: Maintenance;
  /**
   * 이보다 낮은 화면 버전은 강제 업데이트(BRD-43).
   */
  minWebBuild: number;
  files: {
    beaches: SnapshotPath;
    status: SnapshotPath;
    history: SnapshotPath;
    nationwideWarnings: SnapshotPath;
  };
}
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "Maintenance".
 */
export interface Maintenance {
  active: boolean;
  until: NullableDateTime;
}
/**
 * /data/{v}/beaches.json. 저장소 data/beaches에서 만듦(17.5).
 *
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "BeachesFile".
 */
export interface BeachesFile {
  beaches: Beach[];
}
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "Beach".
 */
export interface Beach {
  id: BeachId;
  /**
   * 주소용. 한 번 정하면 바꾸지 않음(BRD-45).
   */
  slug: string;
  name: LocalizedText;
  region: {
    sido: LocalizedText;
    sigungu: LocalizedText;
  };
  coords: {
    lat: number;
    lng: number;
  };
  /**
   * 스노클링은 출시 제외(B7).
   *
   * @minItems 1
   */
  activities: ['swimming' | 'surfing' | 'scuba', ...('swimming' | 'surfing' | 'scuba')[]];
  /**
   * 노출 끔. true면 목록에서 숨기고 상세는 404(BRD-45).
   */
  hidden: boolean;
  warningZones: {
    /**
     * 앞바다 특보구역(풍랑).
     */
    sea: string;
    /**
     * 시군 육상 특보구역(강풍).
     */
    land: string;
  };
  stations: {
    waveHeight: StationRef;
    wavePeriod: StationRef;
    waveDirection: StationRef;
    waterTemp: StationRef;
    wind: StationRef;
  };
  photo: null | {
    url: string;
    source: string;
    /**
     * 공공누리 유형 원문(D9).
     */
    license: string;
  };
  cctv: null | {
    /**
     * https 직접 표시만(D7).
     */
    url: string;
    source: string;
  };
}
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "LocalizedText".
 */
export interface LocalizedText {
  ko: string;
  en: string;
}
/**
 * /data/{v}/status.json. 키는 해변 내부 id.
 *
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "StatusFile".
 */
export interface StatusFile {
  beaches: {
    [k: string]: BeachStatus;
  };
}
export interface BeachStatus1 {
  category: 'clear' | 'unavailable' | 'undetermined';
  reasons: Reason[];
  warning: WarningState;
  control: {
    /**
     * 출시는 통제를 판단하지 않음(G2).
     */
    state: 'not_provided';
  };
  observation: {
    metrics: {
      waveHeight: Metric;
      wavePeriod: Metric;
      waveDirection: Metric;
      waterTemp: Metric;
      wind: Metric;
    };
  };
  info: {
    /**
     * 운영 기간 정보. 대응표가 없으면 null(배지 숨김, N4).
     */
    season: null | {
      openFrom: string;
      openUntil: string;
      inSeason: boolean;
    };
    /**
     * 이안류 지수. 정보 표시만(D5). 제공 해변·기간이 아니면 null. 단계 값 형식은 API 확인 후 확정.
     */
    ripCurrent: null | {
      /**
       * 기관 발표 단계 원문.
       */
      label: string;
      publishedAt: DateTime;
      source: string;
    };
    /**
     * 주변 특보. 판단에 쓰지 않는 특보(호우·폭염 등)를 정보로만 표시(B3, 10/17 결정). 없으면 빈 목록.
     */
    nearbyWarnings: NearbyWarningItem[];
  };
  validUntil: DateTime1;
}
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "Reason".
 */
export interface Reason {
  /**
   * 통제 code(control_*)는 후속용으로 이름만 예약(아키텍처 6.3).
   */
  code: 'warning' | 'warning_unknown' | 'observation_delayed';
  type?: WarningType;
  level?: WarningLevel;
  /**
   * 범위. 예: 특보구역 이름, 관측소 이름.
   */
  scope: string;
  /**
   * 기관. 예: 기상청.
   */
  source: string;
  at: NullableDateTime1;
}
export interface WarningState1 {
  state: 'none' | 'active' | 'unknown';
  items: WarningItem[];
  source: string;
  lastConfirmedAt: NullableDateTime2;
}
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "WarningItem".
 */
export interface WarningItem {
  type: WarningType;
  level: WarningLevel;
  zoneCode: string;
  zoneName: string;
  publishedAt: DateTime;
  effectiveFrom: DateTime;
}
export interface Metric1 {
  value: number | null;
  unit: 'm' | 's' | 'deg' | '°C' | 'm/s';
  observedAt: NullableDateTime2;
  /**
   * none = 20km 안 측정기 없음(분류 영향 없음).
   */
  state: 'fresh' | 'delayed' | 'none';
  nextExpectedAt: NullableDateTime2;
  expiresAt: NullableDateTime3;
}
/**
 * 주변 특보 항목. 분류에 영향 없음.
 *
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "NearbyWarningItem".
 */
export interface NearbyWarningItem {
  type: NearbyWarningType;
  level: WarningLevel;
  zoneCode: string;
  zoneName: string;
  publishedAt: DateTime;
  effectiveFrom: DateTime;
}
/**
 * /data/{v}/history.json. 관측소별 최근 24시간 파고, 1시간 간격(B2).
 *
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "HistoryFile".
 */
export interface HistoryFile {
  stations: {
    [k: string]: WaveHeightHistory;
  };
}
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "WaveHeightHistory".
 */
export interface WaveHeightHistory {
  unit: 'm';
  /**
   * @maxItems 25
   */
  points: {
    t: DateTime;
    /**
     * null = 측정값 없음(차트 빗금).
     */
    v: number | null;
  }[];
}
/**
 * /data/{v}/nationwide-warnings.json. 홈의 '전국 해상 특보'.
 *
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "NationwideWarningsFile".
 */
export interface NationwideWarningsFile {
  lastConfirmedAt: NullableDateTime2;
  items: WarningItem[];
}
