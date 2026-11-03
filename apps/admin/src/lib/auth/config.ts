// 사용자 풀 설정 (BRD-148). 풀 ID·앱 클라이언트 ID는 비밀값이 아님(스택 출력, infra/README)
// 빌드 때 NEXT_PUBLIC_* 값으로 들어감. 하나라도 비거나 모양이 틀리면 null → 화면은 '설정 오류'를 보여 줌
// Next.js는 process.env.NEXT_PUBLIC_* 을 글자 그대로 쓴 곳만 바꿔 넣으므로 하나씩 적음

export type PoolKind = "operator" | "demo";

export interface PoolConfig {
  readonly userPoolId: string;
  readonly clientId: string;
}

const POOL_ID = /^ap-northeast-2_[A-Za-z0-9]{1,55}$/;
const CLIENT_ID = /^[a-z0-9]{1,128}$/;

export function poolConfigFrom(
  values: Record<string, string | undefined>,
): Record<PoolKind, PoolConfig> | null {
  const pools = {
    operator: {
      userPoolId: values.operatorPool ?? "",
      clientId: values.operatorClient ?? "",
    },
    demo: {
      userPoolId: values.demoPool ?? "",
      clientId: values.demoClient ?? "",
    },
  };
  const valid = Object.values(pools).every(
    (p) => POOL_ID.test(p.userPoolId) && CLIENT_ID.test(p.clientId),
  );
  return valid ? pools : null;
}

export const POOLS = poolConfigFrom({
  operatorPool: process.env.NEXT_PUBLIC_OPERATOR_USER_POOL_ID,
  operatorClient: process.env.NEXT_PUBLIC_OPERATOR_CLIENT_ID,
  demoPool: process.env.NEXT_PUBLIC_DEMO_USER_POOL_ID,
  demoClient: process.env.NEXT_PUBLIC_DEMO_CLIENT_ID,
});
