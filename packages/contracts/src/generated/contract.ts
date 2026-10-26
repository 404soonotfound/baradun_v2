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
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "Beach".
 */
export type Beach = Beach1 & Beach2;
export type Beach1 = BeachSite | DivePoint;
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
 * via the `definition` "WarningItem".
 */
export type WarningItem = WarningItem1;
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
 * 파고·수온·바람 observedAt + 90분, 파주기·파향 + 60분(B4, 파향은 파주기와 같은 kma_buoy, 10/21).
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
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "InquiryPhotoId".
 */
export type InquiryPhotoId = string;
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "InquiryPhotoKey".
 */
export type InquiryPhotoKey = string;
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "InquiryType".
 */
export type InquiryType = 'data_error' | 'data_question' | 'other';
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "InquiryId".
 */
export type InquiryId = string;
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "InquiryPhotoResult".
 */
export type InquiryPhotoResult =
  | {
      photoId: InquiryPhotoId;
      status: 'accepted';
    }
  | {
      photoId: InquiryPhotoId;
      status: 'rejected';
      reason: 'location_metadata' | 'invalid_file' | 'not_found';
    };

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
export interface BeachSite {
  /**
   * 해변. beach = 해수부 지정 해수욕장, undesignated_beach = 지정 해수욕장이 아닌 해변(결정 기록 11장 10/21, BRD-73).
   */
  kind: 'beach' | 'undesignated_beach';
  warningZones: WarningZones;
}
/**
 * 해변의 특보구역. 앞바다(풍랑)·시군 육상(강풍) 모두 필수.
 *
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "WarningZones".
 */
export interface WarningZones {
  /**
   * 앞바다 특보구역(풍랑).
   */
  sea: string;
  /**
   * 시군 육상 특보구역(강풍).
   */
  land: string;
}
export interface DivePoint {
  /**
   * 스쿠버 포인트(바다 위). 육상 구역 생략 가능(결정 기록 11장 10/21, BRD-73).
   */
  kind: 'dive_point';
  warningZones: SeaWarningZones;
}
/**
 * 스쿠버 포인트의 특보구역. 바다 위라 육상 구역은 생략 가능.
 *
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "SeaWarningZones".
 */
export interface SeaWarningZones {
  /**
   * 앞바다 특보구역(풍랑).
   */
  sea: string;
  /**
   * 시군 육상 특보구역(강풍). 생략 가능.
   */
  land?: string;
}
export interface Beach2 {
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
  /**
   * 해안 구분(동해안·서해안·남해안·제주). 지진해일 발표 지역 글과 장소를 잇는 데 씀(결정 기록 11장 10/20 ⑥·10/21 ④).
   */
  coast: 'east' | 'west' | 'south' | 'jeju';
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
     * 공공누리 유형 코드값(D9). 1유형(출처표시)만 사용(결정 기록 11장 10/21). 화면 표기는 문구 키로.
     */
    license: 'kogl-type1';
    /**
     * 저작물명(출처 표시용).
     */
    title?: string;
    /**
     * 원본 페이지(출처 표시용).
     */
    pageUrl?: string;
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
export interface WarningItem1 {
  type: WarningType;
  level: WarningLevel;
  /**
   * 특보구역 코드. 지진해일만 null(구역 코드 없음, 10/22).
   */
  zoneCode: string | null;
  /**
   * 공식 구역 이름. 지진해일은 getTsunamiMsg reg 원문.
   */
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
/**
 * 문의 사진 업로드 양식 발급 요청.
 *
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "InquiryUploadRequest".
 */
export interface InquiryUploadRequest {
  /**
   * @minItems 1
   * @maxItems 3
   */
  photos:
    | [InquiryUploadPhoto]
    | [InquiryUploadPhoto, InquiryUploadPhoto]
    | [InquiryUploadPhoto, InquiryUploadPhoto, InquiryUploadPhoto];
}
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "InquiryUploadPhoto".
 */
export interface InquiryUploadPhoto {
  contentType: 'image/jpeg' | 'image/png' | 'image/webp';
  size: number;
}
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "InquiryUploadResponse".
 */
export interface InquiryUploadResponse {
  /**
   * @maxItems 3
   */
  uploads:
    | []
    | [InquiryUploadTarget]
    | [InquiryUploadTarget, InquiryUploadTarget]
    | [InquiryUploadTarget, InquiryUploadTarget, InquiryUploadTarget];
}
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "InquiryUploadTarget".
 */
export interface InquiryUploadTarget {
  photoId: InquiryPhotoId;
  key: InquiryPhotoKey;
  url: string;
  fields: {
    [k: string]: string;
  };
  expiresAt: DateTime;
}
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "CreateInquiryRequest".
 */
export interface CreateInquiryRequest {
  type: InquiryType;
  message: string;
  email?: string;
  /**
   * @maxItems 3
   */
  photos:
    | []
    | [InquiryPhotoReference]
    | [InquiryPhotoReference, InquiryPhotoReference]
    | [InquiryPhotoReference, InquiryPhotoReference, InquiryPhotoReference];
}
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "InquiryPhotoReference".
 */
export interface InquiryPhotoReference {
  photoId: InquiryPhotoId;
  key: InquiryPhotoKey;
}
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "CreateInquiryResponse".
 */
export interface CreateInquiryResponse {
  inquiryId: InquiryId;
  receivedAt: DateTime;
  /**
   * @maxItems 3
   */
  photos:
    | []
    | [InquiryPhotoResult]
    | [InquiryPhotoResult, InquiryPhotoResult]
    | [InquiryPhotoResult, InquiryPhotoResult, InquiryPhotoResult];
}
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "InquiryErrorResponse".
 */
export interface InquiryErrorResponse {
  error: {
    code: 'invalid_request' | 'rate_limited' | 'service_unavailable';
    message: string;
  };
}
