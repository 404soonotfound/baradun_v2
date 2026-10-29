// 문의에서 이메일·사진을 받을지(결정 기록 13장 D13-1·D13-2, BRD-130). 출시 기본값은 받지 않음
// 끄면 사진 업로드 발급을 막고 이메일·사진이 담긴 문의를 거절함(화면에서만 숨기지 않음)
// apps/web/src/lib/inquiry/form.ts의 같은 이름 값과 같아야 함(infra/test/inquiry.test.ts가 확인)
// 다시 켜기 전 필수: BRD-116·117·119, 처리방침 항목 추가, 고지 버전 올림(D13-3)
export const INQUIRY_CONTACT_ENABLED = false;
export const INQUIRY_BODY_RETENTION_DAYS = 90;
export const INQUIRY_EMAIL_RETENTION_DAYS = 88;
export const INQUIRY_PHOTO_RETENTION_DAYS = 30;
export const INQUIRY_MAX_PHOTOS = 3;
// 기기에서 줄인 최종 파일 상한(결정 기록 12장 결정 23: 최종 3~4MiB, 클라이언트·서버 양쪽 검사)
export const INQUIRY_MAX_PHOTO_BYTES = 4 * 1024 * 1024;
export const INQUIRY_MAX_BODY_BYTES = 32 * 1024;
export const INQUIRY_RATE_LIMIT_PER_MINUTE = 10;
export const INQUIRY_NOTIFICATION_LIMIT_PER_DAY = 20;
export const INQUIRY_UPLOAD_EXPIRES_SECONDS = 10 * 60;
// 멱등 기록 보관. 웹은 키를 화면 메모리에만 두고 같은 화면에서 다시 보낼 때만 씀
export const INQUIRY_IDEMPOTENCY_RETENTION_DAYS = 1;
export const INQUIRY_SUMMARY_MAX_LENGTH = 120;

export function ttlAfterDays(now: Date, days: number): number {
  return Math.floor(now.getTime() / 1000) + days * 24 * 60 * 60;
}

export function kstDate(now: Date): string {
  return new Date(now.getTime() + 9 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}
