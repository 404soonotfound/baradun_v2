"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuthSession, useSessionSnapshot } from "@/lib/auth/provider";
import { messages } from "@/lib/messages";
import { BrandRow, Button } from "./ui";

// 운영 화면 머리 (BRD-148). 왼쪽 메뉴는 운영 홈(BRD-149)에서 붙임
// 권한 이름은 토큰의 그룹으로 보여 주지만 판단은 서버가 요청마다 다시 함(D16-A7)

const t = messages;

export function roleLabel(
  pool: "operator" | "demo",
  groups: readonly string[],
) {
  if (pool === "demo") return t.home.roleDemo;
  if (groups.includes("publisher")) return t.home.rolePublisher;
  if (groups.includes("editor")) return t.home.roleEditor;
  if (groups.includes("viewer")) return t.home.roleViewer;
  return null;
}

export function AdminHeader() {
  const router = useRouter();
  const session = useAuthSession();
  const snapshot = useSessionSnapshot();
  if (snapshot.status === "signed_out") return null;
  return (
    <header className="border-b border-border-default bg-bg-surface">
      <div className="mx-auto flex w-full max-w-[960px] items-center justify-between gap-3 px-4 py-3">
        <Link href="/" aria-label={t.home.title}>
          <BrandRow />
        </Link>
        <nav className="flex shrink-0 items-center gap-2">
          <Link
            href="/account/"
            className="inline-flex h-9 items-center rounded-[6px] px-3 text-[13px] font-medium whitespace-nowrap text-text-default hover:bg-bg-page"
          >
            {t.home.account}
          </Link>
          <Button
            variant="secondary"
            size="small"
            onClick={() => {
              void session.logout();
              router.replace(
                snapshot.pool === "demo" ? "/login/demo/" : "/login/",
              );
            }}
          >
            {t.home.logout}
          </Button>
        </nav>
      </div>
    </header>
  );
}
