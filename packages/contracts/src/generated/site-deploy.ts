// 자동 생성 파일: 직접 고치지 말고 schemas/를 고친 뒤 `npm run generate`
export const SITE_DEPLOY_REASONS = [
  "unconfigured",
  "credential_missing",
  "credentials",
  "unauthorized",
  "forbidden",
  "not_found",
  "timeout",
  "rate_limit",
  "unavailable",
  "invalid",
  "truncated",
  "not_ancestor",
] as const;

export const READINESS = [
  "ready",
  "paused",
  "deploying",
  "approval_pending",
  "ci_pending",
  "ci_failed",
  "ci_missing",
  "unconfigured",
  "unknown",
] as const;

export const CI_STATES = [
  "success",
  "pending",
  "failure",
  "missing",
] as const;

export const SITE_APPS = [
  "site",
  "admin",
] as const;

export const FILE_CATEGORIES = [
  "beach",
  "site",
  "admin",
  "shared",
] as const;

export const DEPLOY_EVENTS = [
  "schedule",
  "workflow_dispatch",
] as const;

export const SCHEDULE_UNAVAILABLE = [
  "paused",
  "workflow_disabled",
  "unconfigured",
] as const;
