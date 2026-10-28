// 공유 (BRD-34 · 노션 2장 SHARE): 링크 만들기 · 기기 공유 창 · 링크 복사 · 메시지
// 공유 링크에는 해변 주소만 넣음. 사용자 위치·활동·검색어 같은 개인 정보와 해변 상태는 넣지 않음
// (결정 기록 11장 10/16: 공유 미리보기는 해변 이름·지역·사진만, S16: 들어오면 항상 지금 상태)
import { type Locale, localizedPath } from "@/lib/i18n";

// 공유할 해변 주소. origin(예: https://baradun.kr)에 해변 경로만 붙임(쿼리·해시 없음)
// origin이 http(s)가 아니면 null(파일 주소·잘못된 값으로 링크를 만들지 않음)
export function shareUrl(
  origin: string,
  locale: Locale,
  slug: string,
): string | null {
  let base: URL;
  try {
    base = new URL(origin);
  } catch {
    return null;
  }
  if (base.protocol !== "https:" && base.protocol !== "http:") return null;
  return new URL(
    localizedPath(locale, `/spots/${encodeURIComponent(slug)}/`),
    base.origin,
  ).href;
}

// 기기 공유 창 결과
//   shared: 공유함 · cancelled: 사용자가 닫음(아무것도 하지 않음)
//   unsupported: 공유 창이 없는 브라우저 · failed: 공유 창이 실패(둘 다 링크 복사로 대신함)
export type ShareResult = "shared" | "cancelled" | "unsupported" | "failed";

type ShareNavigator = {
  share?: (data: ShareData) => Promise<void>;
  canShare?: (data: ShareData) => boolean;
};

export async function shareWithDevice(
  nav: ShareNavigator | undefined,
  data: { title: string; url: string },
): Promise<ShareResult> {
  if (!nav || typeof nav.share !== "function") return "unsupported";
  try {
    if (typeof nav.canShare === "function" && !nav.canShare(data)) {
      return "unsupported";
    }
    await nav.share(data);
    return "shared";
  } catch (error) {
    // 사용자가 공유 창을 닫으면 AbortError. 그 밖(권한·보안 오류 등)은 실패로 봄
    if (error instanceof Error && error.name === "AbortError") {
      return "cancelled";
    }
    return "failed";
  }
}

// 링크 복사 결과. 클립보드가 없거나(보안 연결 아님 등) 쓰기를 거부하면 failed
export type CopyResult = "copied" | "failed";

type ClipboardLike = { writeText?: (text: string) => Promise<void> };

export async function copyText(
  clipboard: ClipboardLike | undefined,
  text: string,
): Promise<CopyResult> {
  if (!clipboard || typeof clipboard.writeText !== "function") return "failed";
  try {
    await clipboard.writeText(text);
    return "copied";
  } catch {
    return "failed";
  }
}

// 메시지(문자) 앱으로 보내는 주소. iOS·Android 모두 읽는 "sms:?&body=" 형식
export function smsHref(body: string): string {
  return `sms:?&body=${encodeURIComponent(body)}`;
}
