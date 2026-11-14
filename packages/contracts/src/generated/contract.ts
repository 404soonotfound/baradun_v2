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
 * UTC(Z)만. 시간대가 붙은 값(+09:00)은 거부(KST·UTC 섞임 방지). 예: 2026-10-17T05:30:00Z
 *
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "UtcDateTime".
 */
export type UtcDateTime = string;
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "NullableUtcDateTime".
 */
export type NullableUtcDateTime = string | null;
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "SnapshotPath".
 */
export type SnapshotPath = string;
/**
 * 날씨 예보(BRD-181, D18-1). 선택 칸: schemaVersion 1에 더한 칸이라 이 칸을 모르는 화면은 무시함. 없으면 화면은 '날씨를 확인하지 못했어요'. 판단 상태와 상관없음.
 */
export type SnapshotPath1 = string;
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
 * 출시 활동 3종(B7). 해변 activities와 문의 activity(장소 상세에서 들어온 문의의 해변 beachId와 함께만 보냄, 결정 기록 12장 결정 22)가 같이 씀.
 *
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "Activity".
 */
export type Activity = 'swimming' | 'surfing' | 'scuba';
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
 * 하늘. 기상청 단기예보 SKY 1 맑음·3 구름많음·4 흐림, 중기예보 wf 글자의 앞부분. null = 값 없음(맑음으로 채우지 않음).
 *
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "WeatherSky".
 */
export type WeatherSky = 'clear' | 'mostlyCloudy' | 'cloudy' | null;
/**
 * 강수 형태. 기상청 단기예보 PTY 0 없음·1 비·2 비/눈·3 눈·4 소나기, 중기예보 wf 글자의 뒷부분. null = 값 없음.
 *
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "WeatherPrecip".
 */
export type WeatherPrecip = 'none' | 'rain' | 'rainSnow' | 'snow' | 'shower' | null;
/**
 * 한국 시각 날짜. 예: 2026-11-05
 *
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "KstDate".
 */
export type KstDate = string;
/**
 * 그 강수확률이 나온 시각(같은 값이면 이른 시각).
 */
export type NullableUtcDateTime1 = string | null;
/**
 * 하늘. 기상청 단기예보 SKY 1 맑음·3 구름많음·4 흐림, 중기예보 wf 글자의 앞부분. null = 값 없음(맑음으로 채우지 않음).
 */
export type WeatherSky1 = 'clear' | 'mostlyCloudy' | 'cloudy' | null;
/**
 * 강수 형태. 기상청 단기예보 PTY 0 없음·1 비·2 비/눈·3 눈·4 소나기, 중기예보 wf 글자의 뒷부분. null = 값 없음.
 */
export type WeatherPrecip1 = 'none' | 'rain' | 'rainSnow' | 'snow' | 'shower' | null;
/**
 * UTC(Z)만. 시간대가 붙은 값(+09:00)은 거부(KST·UTC 섞임 방지). 예: 2026-10-17T05:30:00Z
 */
export type UtcDateTime1 = string;
/**
 * 이 날짜 값을 준 발표 시각. null = 받지 못함 또는 발표 뒤 24시간 지남(이때 나머지 칸도 null).
 */
export type NullableUtcDateTime2 = string | null;
/**
 * 하늘. 기상청 단기예보 SKY 1 맑음·3 구름많음·4 흐림, 중기예보 wf 글자의 앞부분. null = 값 없음(맑음으로 채우지 않음).
 */
export type WeatherSky2 = 'clear' | 'mostlyCloudy' | 'cloudy' | null;
/**
 * 강수 형태. 기상청 단기예보 PTY 0 없음·1 비·2 비/눈·3 눈·4 소나기, 중기예보 wf 글자의 뒷부분. null = 값 없음.
 */
export type WeatherPrecip2 = 'none' | 'rain' | 'rainSnow' | 'snow' | 'shower' | null;
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "InquiryPhotoContentType".
 */
export type InquiryPhotoContentType = 'image/jpeg' | 'image/png' | 'image/webp';
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
 * 문의 한 건의 멱등 키(UUID v4). 같은 내용을 다시 보낼 때 같은 키를 씀. 서버는 같은 키의 두 번째 요청에 첫 결과를 그대로 돌려주고, 내용이 다르면 idempotency_conflict(409)로 거부함.
 *
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "InquiryIdempotencyKey".
 */
export type InquiryIdempotencyKey = string;
/**
 * 화면 유형 칩과 1:1(결정 기록 12장 결정 21). 정보가 실제와 달라요 · 판단 기준이 궁금해요 · 해변을 추가해 주세요 · 새 데이터를 제안해요.
 *
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "InquiryType".
 */
export type InquiryType = 'data_error' | 'data_question' | 'beach_request' | 'data_suggestion';
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
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "SiteDeployReason".
 */
export type SiteDeployReason =
  | 'unconfigured'
  | 'credential_missing'
  | 'credentials'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'timeout'
  | 'rate_limit'
  | 'unavailable'
  | 'invalid'
  | 'truncated'
  | 'not_ancestor';
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "SiteDeployReadiness".
 */
export type SiteDeployReadiness =
  | 'ready'
  | 'paused'
  | 'deploying'
  | 'approval_pending'
  | 'ci_pending'
  | 'ci_failed'
  | 'ci_missing'
  | 'unconfigured'
  | 'unknown';
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "SiteDeployCiState".
 */
export type SiteDeployCiState = 'success' | 'pending' | 'failure' | 'missing';
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "SiteDeployApp".
 */
export type SiteDeployApp = 'site' | 'admin';
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "SiteDeployFileCategory".
 */
export type SiteDeployFileCategory = 'beach' | 'site' | 'admin' | 'shared';
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "SiteDeployEvent".
 */
export type SiteDeployEvent = 'schedule' | 'workflow_dispatch';
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "SiteDeploySha".
 */
export type SiteDeploySha = string;
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "SiteDeployRunUrl".
 */
export type SiteDeployRunUrl = string;
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "SiteDeployScheduleUnavailable".
 */
export type SiteDeployScheduleUnavailable = 'paused' | 'workflow_disabled' | 'unconfigured';
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "SiteDeployScheduleReason".
 */
export type SiteDeployScheduleReason =
  | {
      kind: SiteDeployScheduleUnavailable;
    }
  | {
      kind: 'unknown';
      reason: SiteDeployReason;
      retryAt?: UtcDateTime;
    };
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "SiteDeployCommitField".
 */
export type SiteDeployCommitField =
  | {
      status: 'known';
      value: SiteDeployCommit;
      checkedAt: UtcDateTime;
    }
  | {
      status: 'unknown';
      reason: SiteDeployReason;
      checkedAt: UtcDateTime;
      last?: {
        status: 'known';
        value: SiteDeployCommit;
        checkedAt: UtcDateTime;
      };
      retryAt?: UtcDateTime;
    };
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "SiteDeployShaField".
 */
export type SiteDeployShaField =
  | {
      status: 'known';
      value: SiteDeploySha;
      checkedAt: UtcDateTime;
    }
  | {
      status: 'unknown';
      reason: SiteDeployReason;
      checkedAt: UtcDateTime;
      last?: {
        status: 'known';
        value: SiteDeploySha;
        checkedAt: UtcDateTime;
      };
      retryAt?: UtcDateTime;
    };
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "SiteDeployChangesField".
 */
export type SiteDeployChangesField =
  | {
      status: 'known';
      value: SiteDeployChanges;
      checkedAt: UtcDateTime;
    }
  | {
      status: 'unknown';
      reason: SiteDeployReason;
      checkedAt: UtcDateTime;
      last?: {
        status: 'known';
        value: SiteDeployChanges;
        checkedAt: UtcDateTime;
      };
      retryAt?: UtcDateTime;
    };
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "SiteDeployCiField".
 */
export type SiteDeployCiField =
  | {
      status: 'known';
      value: SiteDeployCiState;
      checkedAt: UtcDateTime;
    }
  | {
      status: 'unknown';
      reason: SiteDeployReason;
      checkedAt: UtcDateTime;
      last?: {
        status: 'known';
        value: SiteDeployCiState;
        checkedAt: UtcDateTime;
      };
      retryAt?: UtcDateTime;
    };
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "SiteDeploySettingsField".
 */
export type SiteDeploySettingsField =
  | {
      status: 'known';
      value: SiteDeploySettings;
      checkedAt: UtcDateTime;
    }
  | {
      status: 'unknown';
      reason: SiteDeployReason;
      checkedAt: UtcDateTime;
      last?: {
        status: 'known';
        value: SiteDeploySettings;
        checkedAt: UtcDateTime;
      };
      retryAt?: UtcDateTime;
    };
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "SiteDeployWorkflowActiveField".
 */
export type SiteDeployWorkflowActiveField =
  | {
      status: 'known';
      value: boolean;
      checkedAt: UtcDateTime;
    }
  | {
      status: 'unknown';
      reason: SiteDeployReason;
      checkedAt: UtcDateTime;
      last?: {
        status: 'known';
        value: boolean;
        checkedAt: UtcDateTime;
      };
      retryAt?: UtcDateTime;
    };
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "SiteDeployDeploymentsField".
 */
export type SiteDeployDeploymentsField =
  | {
      status: 'known';
      value: SiteDeployDeployments;
      checkedAt: UtcDateTime;
    }
  | {
      status: 'unknown';
      reason: SiteDeployReason;
      checkedAt: UtcDateTime;
      last?: {
        status: 'known';
        value: SiteDeployDeployments;
        checkedAt: UtcDateTime;
      };
      retryAt?: UtcDateTime;
    };
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "SiteDeployApprovalsField".
 */
export type SiteDeployApprovalsField =
  | {
      status: 'known';
      value: number[];
      checkedAt: UtcDateTime;
    }
  | {
      status: 'unknown';
      reason: SiteDeployReason;
      checkedAt: UtcDateTime;
      last?: {
        status: 'known';
        value: number[];
        checkedAt: UtcDateTime;
      };
      retryAt?: UtcDateTime;
    };
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "SiteDeployRecentJobsField".
 */
export type SiteDeployRecentJobsField =
  | {
      status: 'known';
      value: SiteDeployRecentJobs;
      checkedAt: UtcDateTime;
    }
  | {
      status: 'unknown';
      reason: SiteDeployReason;
      checkedAt: UtcDateTime;
      last?: {
        status: 'known';
        value: SiteDeployRecentJobs;
        checkedAt: UtcDateTime;
      };
      retryAt?: UtcDateTime;
    };
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "SiteDeployManualCountField".
 */
export type SiteDeployManualCountField =
  | {
      status: 'known';
      value: SiteDeployManualCount;
      checkedAt: UtcDateTime;
    }
  | {
      status: 'unknown';
      reason: SiteDeployReason;
      checkedAt: UtcDateTime;
      last?: {
        status: 'known';
        value: SiteDeployManualCount;
        checkedAt: UtcDateTime;
      };
      retryAt?: UtcDateTime;
    };
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "SiteDeployTokenExpiryField".
 */
export type SiteDeployTokenExpiryField =
  | {
      status: 'known';
      value: string | null;
      checkedAt: UtcDateTime;
    }
  | {
      status: 'unknown';
      reason: SiteDeployReason;
      checkedAt: UtcDateTime;
      last?: {
        status: 'known';
        value: string | null;
        checkedAt: UtcDateTime;
      };
      retryAt?: UtcDateTime;
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
  /**
   * 공지(BRD-151, D15-6·D16-B3·D4). 선택 칸: 없으면 공지 없음. schemaVersion 1에 더한 칸이라 이 칸을 모르는 화면은 무시함(D20-19, 구현 제안 I06 채택). 예약 시각 전 공지는 넣지 않음. 판단 상태·maintenance를 바꾸지 않음.
   */
  notices?: Notice[];
  files: {
    beaches: SnapshotPath;
    status: SnapshotPath;
    history: SnapshotPath;
    nationwideWarnings: SnapshotPath;
    weather?: SnapshotPath1;
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
 * 공지 하나. 한·영 제목·본문이 모두 있어야 함. 글자 수 상한(제목 한 40/영 60, 본문 한 120/영 200, grapheme)은 게시 전 서버 검사(D16-D2·D20-20 확정). 노출은 startsAt 포함·endsAt 제외(UTC), 화면이 끝 시각부터 숨김. endsAt이 null이면 끝을 정하지 않은 공지(운영자가 노출을 끝내면 다음 게시에서 빠짐)(D16-D4, 구현 제안 I09).
 *
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "Notice".
 */
export interface Notice {
  /**
   * 공지 ID. 같은 종류·같은 시작 시각이면 이 값 오름차순으로 고름.
   */
  id: string;
  /**
   * maintenance_notice: 점검 예고(실제 점검 전환은 maintenance), general: 일반 공지. 한 자리에는 점검 예고가 먼저.
   */
  kind: 'maintenance_notice' | 'general';
  title: LocalizedText;
  body: LocalizedText;
  startsAt: UtcDateTime;
  endsAt: NullableUtcDateTime;
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
  activities: [Activity, ...Activity[]];
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
 * /data/{v}/weather.json. 기상청 단기예보·초단기실황·중기예보(BRD-181, 결정 기록 18장 D18-1·D18-2·D18-8·D18-9). 참고 정보: 분류·관측 지연·대안 해변에 쓰지 않음(G1). 받지 못했거나 오래된 값은 null(0·맑음·빈 칸으로 채우지 않음). 출처 표시 '출처: 기상청'(기상법).
 *
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "WeatherFile".
 */
export interface WeatherFile {
  /**
   * 해변 id → 예보 구역(data/weather-areas.json). 없는 해변은 날씨 없음.
   */
  beaches: {
    [k: string]: WeatherAreas;
  };
  /**
   * 격자 'nx,ny' → 단기예보·오늘 최저/최고·지금 기온.
   */
  grids: {
    [k: string]: WeatherGrid;
  };
  /**
   * 중기 육상 구역 → 하늘·강수확률(글피 다음 날부터 3일).
   */
  midLand: {
    [k: string]: MidLandForecast;
  };
  /**
   * 중기 기온 지점 → 최저·최고(글피 다음 날부터 3일).
   */
  midTa: {
    [k: string]: MidTaForecast;
  };
}
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "WeatherAreas".
 */
export interface WeatherAreas {
  /**
   * 단기예보·초단기실황 5km 격자 'nx,ny'.
   */
  grid: string;
  /**
   * 중기예보 육상 구역 코드(getMidLandFcst regId).
   */
  midLand: string;
  /**
   * 중기예보 기온 지점 코드(getMidTa regId).
   */
  midTa: string;
}
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "WeatherGrid".
 */
export interface WeatherGrid {
  /**
   * 단기예보. null = 받지 못함 또는 발표 뒤 12시간 지남.
   */
  short: WeatherShort | null;
  today: WeatherToday;
  /**
   * 지금 기온(초단기실황 T1H, D18-8 ③). null = 받지 못함 또는 실황 기준 시각 뒤 2시간 지남.
   */
  now: WeatherNow | null;
}
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "WeatherShort".
 */
export interface WeatherShort {
  issuedAt: UtcDateTime;
  /**
   * 오늘~모레(KST) 3시간 간격(00·03·…·21시) 예보, 시각 순. 발표에 없는 시각(발표 전 시각)은 없음.
   *
   * @maxItems 24
   */
  points: WeatherPoint[];
  /**
   * 글피 하루 한 칸(D18-9). 발표가 그날 3시간 간격 칸(KST 00~21시)을 모두 담을 때만 있음. KST 00:00~02:10(전날 23:00 발표가 최신)에는 빈 배열.
   */
  days: WeatherShortDay[];
}
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "WeatherPoint".
 */
export interface WeatherPoint {
  at: UtcDateTime;
  sky: WeatherSky;
  precip: WeatherPrecip;
  /**
   * 기온(°C, TMP).
   */
  temperature: number | null;
  /**
   * 강수확률(%). 0도 값. null = 값 없음.
   */
  pop: number | null;
  /**
   * 바람이 불어오는 방향(도, VEC). 화살표는 180° 돌려 불어가는 쪽으로 그림.
   */
  windFrom: number | null;
  /**
   * 풍속(m/s, WSD).
   */
  windSpeed: number | null;
}
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "WeatherShortDay".
 */
export interface WeatherShortDay {
  date: KstDate;
  /**
   * 그날 예보 중 가장 높은 강수확률(D18-9). null = 그날 강수확률 값 없음.
   */
  pop: number | null;
  popAt: NullableUtcDateTime1;
  sky: WeatherSky1;
  precip: WeatherPrecip1;
  /**
   * 최저기온(°C, TMN).
   */
  min: number | null;
  /**
   * 최고기온(°C, TMX).
   */
  max: number | null;
}
/**
 * 오늘(KST) 최저·최고(TMN·TMX, D18-8 ②). 오늘 값을 담은 가장 늦은 발표(02:00·05:00, 없으면 전날 발표) 값을 그날 내내 씀. 시간별 기온으로 대신하지 않음. 없으면 null.
 *
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "WeatherToday".
 */
export interface WeatherToday {
  date: KstDate;
  /**
   * 오늘 최저기온(°C).
   */
  min: number | null;
  minIssuedAt: NullableUtcDateTime;
  /**
   * 오늘 최고기온(°C).
   */
  max: number | null;
  maxIssuedAt: NullableUtcDateTime;
}
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "WeatherNow".
 */
export interface WeatherNow {
  observedAt: UtcDateTime1;
  /**
   * 기온(°C, T1H).
   */
  temperature: number;
}
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "MidLandForecast".
 */
export interface MidLandForecast {
  /**
   * 기상청 중기 육상 구역 이름(코드표 원문, 예: 강원영동).
   */
  name: string;
  /**
   * 글피 다음 날부터 3일(KST), 날짜 순.
   */
  days: MidLandDay[];
}
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "MidLandDay".
 */
export interface MidLandDay {
  date: KstDate;
  issuedAt: NullableUtcDateTime2;
  /**
   * 그날 오전·오후 중 높은 강수확률(D18-9, 같으면 오전). 8~10일은 하루 값.
   */
  pop: number | null;
  sky: WeatherSky2;
  precip: WeatherPrecip2;
}
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "MidTaForecast".
 */
export interface MidTaForecast {
  /**
   * 기상청 중기 기온 지점 이름(코드표 원문, 예: 강릉).
   */
  name: string;
  days: MidTaDay[];
}
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "MidTaDay".
 */
export interface MidTaDay {
  date: KstDate;
  issuedAt: NullableUtcDateTime;
  /**
   * 최저기온(°C, taMin).
   */
  min: number | null;
  /**
   * 최고기온(°C, taMax).
   */
  max: number | null;
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
  contentType: InquiryPhotoContentType;
  /**
   * 기기에서 줄인 최종 파일 크기. 파일당 4MiB까지(결정 기록 12장 결정 23).
   */
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
  /**
   * multipart/form-data 양식 업로드(S3 presigned POST)만 씀.
   */
  method: 'POST';
  /**
   * 서울 리전 S3 버킷의 가상 호스트 주소. 경로는 / 하나. 웹은 빌드 설정의 버킷 이름과 호스트가 정확히 같은지 다시 확인함.
   */
  url: string;
  fields: InquiryUploadFields;
  expiresAt: DateTime;
}
/**
 * S3 presigned POST 양식 칸. 정해진 칸만 허용함.
 *
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "InquiryUploadFields".
 */
export interface InquiryUploadFields {
  key: InquiryPhotoKey;
  bucket: string;
  'Content-Type': InquiryPhotoContentType;
  Policy: string;
  'X-Amz-Algorithm': 'AWS4-HMAC-SHA256';
  'X-Amz-Credential': string;
  'X-Amz-Date': string;
  'X-Amz-Security-Token'?: string;
  'X-Amz-Signature': string;
}
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "CreateInquiryRequest".
 */
export interface CreateInquiryRequest {
  idempotencyKey: InquiryIdempotencyKey;
  type: InquiryType;
  message: string;
  email?: string;
  beachId?: BeachId;
  activity?: Activity;
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
    code: 'invalid_request' | 'idempotency_conflict' | 'rate_limited' | 'service_unavailable';
    message: string;
  };
}
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "SiteDeployCommit".
 */
export interface SiteDeployCommit {
  sha: SiteDeploySha;
  title: string;
}
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "SiteDeployChangeFile".
 */
export interface SiteDeployChangeFile {
  path: string;
  previous: string | null;
  category: SiteDeployFileCategory;
}
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "SiteDeployChanges".
 */
export interface SiteDeployChanges {
  from: SiteDeploySha;
  to: SiteDeploySha;
  files: SiteDeployChangeFile[];
  commits: SiteDeployCommit[];
}
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "SiteDeployRun".
 */
export interface SiteDeployRun {
  id: number;
  event: SiteDeployEvent;
  status: string;
  attempt: number;
  conclusion: string | null;
  sha: SiteDeploySha;
  createdAt: UtcDateTime;
  url: SiteDeployRunUrl;
}
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "SiteDeployMatchedRun".
 */
export interface SiteDeployMatchedRun {
  event: 'workflow_dispatch';
  url: SiteDeployRunUrl;
  completedAt: UtcDateTime | null;
}
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "SiteDeployJob".
 */
export interface SiteDeployJob {
  status: string;
  conclusion: string | null;
  wroteMarker: boolean;
  completedAt: UtcDateTime | null;
}
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "SiteDeployDeployments".
 */
export interface SiteDeployDeployments {
  recent: SiteDeployRun | null;
  active: SiteDeployRun[];
}
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "SiteDeploySettings".
 */
export interface SiteDeploySettings {
  paused: boolean;
  configured: boolean;
}
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "SiteDeployRecentJobs".
 */
export interface SiteDeployRecentJobs {
  run: SiteDeployRun | null;
  apps: {
    site: SiteDeployJob | null;
    admin: SiteDeployJob | null;
  };
}
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "SiteDeployManualCount".
 */
export interface SiteDeployManualCount {
  since: UtcDateTime;
  requests: number;
}
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "SiteDeploySite".
 */
export interface SiteDeploySite {
  app: SiteDeployApp;
  deployed: SiteDeployShaField;
  detail: SiteDeployCommitField;
  changes: SiteDeployChangesField;
  matchedRun: SiteDeployMatchedRun | null;
  compareUrl?: string;
}
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "SiteDeployView".
 */
export interface SiteDeployView {
  generatedAt: UtcDateTime;
  readiness: SiteDeployReadiness;
  readinessCheckedAt: UtcDateTime;
  main: SiteDeployCommitField;
  ci: SiteDeployCiField;
  settings: SiteDeploySettingsField;
  workflowActive: SiteDeployWorkflowActiveField;
  deployments: SiteDeployDeploymentsField;
  approvals: SiteDeployApprovalsField;
  recentJobs: SiteDeployRecentJobsField;
  manualCount: SiteDeployManualCountField;
  tokenExpiry: SiteDeployTokenExpiryField;
  sites: SiteDeploySite[];
  nextScheduledAt: UtcDateTime | null;
  nextScheduledAtReason?: SiteDeployScheduleReason;
  workflowUrl: string;
}
