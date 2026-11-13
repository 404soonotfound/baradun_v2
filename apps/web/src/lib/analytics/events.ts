import type { Activity, InquiryType } from "@baradun/contracts";
import type { Locale } from "@/lib/i18n";

// GA4 확장 이용 통계 이벤트 (BRD-68 / #247).
// - 개인정보(위치 좌표·시군구·이메일·검색어 원문·문의 본문)와 해변 상태(특보 없음·이용불가·판단불가)는 어떤 이벤트에도 넣지 않음.
// - 운영 빌드에서 GoogleAnalytics가 window.gtag를 붙인 경우에만 전송하고, 비운영(또는 SSR)에서는 아무것도 하지 않음(dataLayer도 만들지 않음).

export type AnalyticsSurface =
  | "home"
  | "explore"
  | "search"
  | "spot"
  | "weather"
  | "favorites"
  | "settings"
  | "onboarding";

export type QueryLengthBucket = "1" | "2_3" | "4_plus";

export interface AnalyticsEventMap {
  select_activity: {
    activity: Activity;
    surface: AnalyticsSurface;
  };
  search_no_result: {
    locale: Locale;
    query_length_bucket: QueryLengthBucket;
  };
  select_search_result: {
    result_kind: "beach" | "recent";
    locale: Locale;
  };
  inquiry_sent: {
    inquiry_type: InquiryType;
    has_beach_context: boolean;
    activity?: Activity | undefined;
  };
  toggle_explore_view: {
    view: "list" | "map";
  };
  open_warning_sheet: {
    surface: AnalyticsSurface;
    locale: Locale;
  };
  open_weather_detail: {
    activity: Activity;
    locale: Locale;
  };
  select_alternative_beach: {
    surface: "spot";
    rank: 1 | 2;
  };
  toggle_favorite: {
    action: "add" | "remove";
    surface: AnalyticsSurface;
  };
  share_spot: {
    method: "web_share" | "copy_link";
    locale: Locale;
  };
  complete_onboarding_notice: {
    notice_version: number;
    locale: Locale;
  };
  respond_location_prompt: {
    choice: "allow" | "skip";
    surface: "onboarding" | "settings";
  };
  change_setting: {
    setting: "language" | "theme" | "motion" | "reset_data";
    value?: string | undefined;
  };
  open_offline_fallback: {
    surface: AnalyticsSurface;
    locale: Locale;
  };
}

export type AnalyticsEventName = keyof AnalyticsEventMap;

export function queryLengthBucket(query: string): QueryLengthBucket {
  const len = query.trim().length;
  if (len <= 1) return "1";
  if (len <= 3) return "2_3";
  return "4_plus";
}

function stripUndefined<T extends Record<string, unknown>>(
  params: T,
): Partial<T> {
  const clean: Partial<T> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      clean[key as keyof T] = value as T[keyof T];
    }
  }
  return clean;
}

type PendingEvent = {
  name: AnalyticsEventName;
  params: Record<string, unknown>;
};

const MAX_PENDING_EVENTS = 50;
const pendingEvents: PendingEvent[] = [];

function getGtag(): ((...args: unknown[]) => void) | null {
  if (typeof window === "undefined") return null;
  const gtag = (window as Window & { gtag?: (...args: unknown[]) => void })
    .gtag;
  return typeof gtag === "function" ? gtag : null;
}

function dispatchEvent(
  gtag: (...args: unknown[]) => void,
  name: AnalyticsEventName,
  params: Record<string, unknown>,
): void {
  try {
    gtag("event", name, params);
  } catch {
    // 분석 전송 실패가 화면 동작을 막지 않음
  }
}

// GA 초기화(config) 전(예: /search/?q=… 직접 진입 직후) 발생한 이벤트를 안전하게 초기화한 뒤 일괄 전송함
export function flushPendingAnalyticsEvents(): void {
  const gtag = getGtag();
  if (!gtag || pendingEvents.length === 0) return;
  const queued = pendingEvents.splice(0, pendingEvents.length);
  for (const item of queued) {
    dispatchEvent(gtag, item.name, item.params);
  }
}

export function clearPendingAnalyticsEvents(): void {
  pendingEvents.length = 0;
}

export function trackEvent<K extends AnalyticsEventName>(
  name: K,
  params: AnalyticsEventMap[K],
): void {
  if (typeof window === "undefined") return;
  const cleanParams = stripUndefined(params);
  const gtag = getGtag();
  if (!gtag) {
    if (pendingEvents.length < MAX_PENDING_EVENTS) {
      pendingEvents.push({ name, params: cleanParams });
    }
    return;
  }
  dispatchEvent(gtag, name, cleanParams);
}
