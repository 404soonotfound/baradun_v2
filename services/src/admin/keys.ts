// 운영 API가 쓰는 Ops 테이블 키 (D16-B2)
// 기존 키(core/store/dynamodb.ts): slot#{job}/{slotId} · lock#{name}/lock · publish/version
// 운영 API 키는 모두 admin# 으로 시작해 게시 잠금·슬롯·게시 버전과 겹치지 않음
//
// - 샘플 계정 허용 설정: admin#config / sample        (D16-A8, 사용자가 CLI로 넣음)
// - 쓰기 멱등 기록:      admin#idem#{key} / idem      (D16-B6, TTL 24시간)
// - 업무 항목:           admin#{종류}#{id} / {sk}     (공지·메모 등, 해당 이슈에서 정함)

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

// 업무 항목 키가 운영 API 범위 안인지 확인. 게시 잠금 등 다른 키를 건드리지 않게 함
export function isAdminKey(key: OpsKey): boolean {
  return (
    key.pk.startsWith(ADMIN_PREFIX) &&
    key.pk !== SAMPLE_CONFIG_KEY.pk &&
    !key.pk.startsWith(`${ADMIN_PREFIX}idem#`)
  );
}
