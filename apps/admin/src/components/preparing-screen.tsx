"use client";

import Link from "next/link";
import { messages } from "@/lib/messages";
import { AdminShell } from "./admin-shell";

// 아직 만들지 않은 운영 화면의 자리 (BRD-171). 메뉴 이동이 S3 오류(403)로 끊기지 않게 함
// 각 화면은 해당 이슈에서 이 자리를 바꿈(화면 설계서 6장 화면 목록)

export function PreparingScreen({ title }: { title: string }) {
  const t = messages.preparing;
  return (
    <AdminShell title={title}>
      <div className="mx-auto flex w-full max-w-[960px] flex-col gap-3 px-4 py-6">
        <h1 className="text-[20px] font-semibold text-text-default">{title}</h1>
        <div className="rounded-[8px] border border-border-default bg-bg-surface px-4 py-5">
          <p className="text-[15px] font-semibold text-text-default">
            {t.title}
          </p>
          <p className="mt-1 text-[13px] text-text-body">{t.body}</p>
          <Link
            href="/"
            className="mt-3 inline-flex h-9 items-center rounded-[6px] border border-border-strong px-3 text-[13px] font-medium text-text-default hover:bg-bg-page"
          >
            {t.home}
          </Link>
        </div>
      </div>
    </AdminShell>
  );
}
