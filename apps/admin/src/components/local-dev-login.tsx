"use client";

import type { PoolKind } from "@/lib/auth/config";
import { localTokens } from "@/lib/auth/local-dev";
import { useAuthSession } from "@/lib/auth/provider";
import { messages } from "@/lib/messages";
import { Button } from "./ui";

// 로컬 개발 서버 전용 테스트 로그인 버튼 (BRD-172). 로그인 화면이 개발 분기 안에서만 불러와 배포 빌드에서는 빠짐
// 들어간 뒤 이동은 로그인 화면의 이동 효과가 함(보던 화면으로)

export function LocalDevLogin({ pool }: { pool: PoolKind }) {
  const session = useAuthSession();
  const t = messages.localDev;
  return (
    <section
      aria-labelledby="local-dev-title"
      className="flex flex-col gap-2 rounded-[8px] border border-dashed border-border-strong p-3"
    >
      <h2
        id="local-dev-title"
        className="text-[13px] font-semibold text-text-default"
      >
        {t.title}
      </h2>
      <p className="text-[12.5px] text-text-body">{t.description}</p>
      <Button
        variant="secondary"
        size="small"
        onClick={() => {
          const now = Date.now();
          session.signIn(pool, localTokens(pool, now, now));
        }}
      >
        {t.signIn}
      </Button>
    </section>
  );
}
