export const INQUIRY_BODY_RETENTION_DAYS = 90;
export const INQUIRY_EMAIL_RETENTION_DAYS = 88;
export const INQUIRY_PHOTO_RETENTION_DAYS = 30;
export const INQUIRY_MAX_PHOTOS = 3;
export const INQUIRY_MAX_PHOTO_BYTES = 5 * 1024 * 1024;
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
