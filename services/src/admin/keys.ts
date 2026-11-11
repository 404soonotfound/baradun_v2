// 운영 API가 쓰는 Ops 테이블 키 (D16-B2)
// 기존 키(core/store/dynamodb.ts): slot#{job}/{slotId} · lock#{name}/lock · publish/version
// 운영 API 키는 모두 admin# 으로 시작해 게시 잠금·슬롯·게시 버전과 겹치지 않음
//
// - 샘플 계정 허용 설정: admin#config / sample        (D16-A8, 사용자가 CLI로 넣음)
// - 쓰기 멱등 기록:      admin#idem#{key} / idem      (D16-B6, TTL 24시간)
// - 감사 기록:           admin#audit#{YYYY-MM} / {시각}#{traceId}  (D16-B5, UTC 월별, TTL 1년, 추가 전용)
// - 공지:               admin#notice / {공지 ID}       (BRD-151, 한 파티션이라 publisher가 Query 한 번으로 읽음)
// - 해변 운영 메모:      admin#beach#{해변 ID} / memo (BRD-150, 내부용. publisher는 admin#notice만 읽어 게시본에 나가지 않음)
// - 업무 항목:           admin#{종류}#{id} / {sk}     (메모 등, 해당 이슈에서 정함)

export interface OpsKey {
  readonly pk: string;
  readonly sk: string;
}

export const ADMIN_PREFIX = "admin#";

export const SAMPLE_CONFIG_KEY: OpsKey = {
  pk: `${ADMIN_PREFIX}config`,
  sk: "sample",
};

export function idempotencyKey(key: string): OpsKey {
  return { pk: `${ADMIN_PREFIX}idem#${key}`, sk: "idem" };
}

export const NOTICE_PK = `${ADMIN_PREFIX}notice`;

export function noticeKey(id: string): OpsKey {
  return { pk: NOTICE_PK, sk: id };
}

export function beachMemoKey(beachId: string): OpsKey {
  return { pk: `${ADMIN_PREFIX}beach#${beachId}`, sk: "memo" };
}

export const AUDIT_PREFIX = `${ADMIN_PREFIX}audit#`;

// 감사 기록 키. 월(UTC)마다 한 파티션, 같은 월 안은 시각 순. traceId로 같은 시각도 겹치지 않음
export function auditKey(at: string, traceId: string): OpsKey {
  return { pk: `${AUDIT_PREFIX}${at.slice(0, 7)}`, sk: `${at}#${traceId}` };
}

// 업무 항목 키가 운영 API 범위 안인지 확인. 게시 잠금 등 다른 키를 건드리지 않게 함
// 감사 기록은 업무 항목이 아님(바꾸지 못하게 versionedWrite 대상에서 뺌)
export function isAdminKey(key: OpsKey): boolean {
  return (
    key.pk.startsWith(ADMIN_PREFIX) &&
    key.pk !== SAMPLE_CONFIG_KEY.pk &&
    !key.pk.startsWith(`${ADMIN_PREFIX}idem#`) &&
    !key.pk.startsWith(AUDIT_PREFIX)
  );
}
