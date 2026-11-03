"use client";

import { useEffect, useState } from "react";
import { opsFetch, type OpsResult } from "@/lib/auth/ops-fetch";
import { useAuthSession, useSessionSnapshot } from "@/lib/auth/provider";
import { fill, messages } from "@/lib/messages";
import { AdminHeader, roleLabel } from "./admin-header";
import { SessionGuard } from "./session-guard";
import { Button, Notice } from "./ui";

// 운영 홈 자리 (BRD-148). 로그인 뒤 /ops/me로 서버가 이 세션을 받아 주는지 먼저 확인함
// 데모 계정이 허용 기간 밖이면 서버가 403(sample_not_allowed) → 화면에서도 막힘을 알림(D16-A8, 캔버스 E11-4)

const t = messages;

interface Me {
  readonly kind: "operator" | "sample";
  readonly role: string;
  readonly sessionExpiresAt: string;
}

function HomeBody() {
  const session = useAuthSession();
  const snapshot = useSessionSnapshot();
  const [me, setMe] = useState<OpsResult<Me> | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    void opsFetch<Me>("/ops/me", () => session.accessToken()).then((result) => {
      if (live) setMe(result);
    });
    return () => {
      live = false;
    };
  }, [session, attempt]);

  const load = () => {
    setMe(null);
    setAttempt((n) => n + 1);
  };

  if (snapshot.status === "signed_out") return null;
  const role = roleLabel(snapshot.pool, snapshot.groups);

  return (
    <main className="mx-auto flex w-full max-w-[960px] flex-col gap-4 px-4 py-6">
      <div>
        <h1 className="text-[20px] font-semibold text-text-default">
          {t.home.title}
        </h1>
        {snapshot.email && (
          <p className="mt-1 text-[13px] text-text-muted">
            {fill(t.home.signedInAs, { email: snapshot.email })}
            {role && ` · ${role}`}
          </p>
        )}
      </div>
      {me && !me.ok && me.code === "sample_not_allowed" && (
        <Notice tone="warn" title={t.home.demoPeriod} role="alert">
          {t.home.demoPeriodHint}
        </Notice>
      )}
      {me &&
        !me.ok &&
        me.code !== "sample_not_allowed" &&
        me.code !== "reauth" && (
          <Notice tone="fail" title={t.home.serverError} role="alert">
            {"requestId" in me && me.requestId && (
              <p>{fill(t.home.requestId, { id: me.requestId })}</p>
            )}
            <Button
              variant="secondary"
              size="small"
              className="mt-2"
              onClick={load}
            >
              {t.home.retry}
            </Button>
          </Notice>
        )}
      {me?.ok && (
        <p className="text-[14px] text-text-body">{t.home.preparing}</p>
      )}
      <p className="text-[12.5px] text-text-muted">{t.session.refreshNote}</p>
    </main>
  );
}

export function HomeScreen() {
  return (
    <SessionGuard header={<AdminHeader />}>
      <HomeBody />
    </SessionGuard>
  );
}
