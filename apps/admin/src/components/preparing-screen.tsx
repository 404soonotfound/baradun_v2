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
      <div className="flex w-full flex-col gap-3 px-4 py-5 md:px-10 md:pt-6 md:pb-10">
        <h1 className="text-title-l font-semibold text-text-default">
          {title}
        </h1>
        <div className="rounded-admin-box border border-border-default bg-bg-surface px-4 py-5">
          <p className="text-title-s font-semibold text-text-default">
            {t.title}
          </p>
          <p className="mt-1 text-body-s text-text-body">{t.body}</p>
          <Link
            href="/"
            className="mt-3 inline-flex h-touch items-center rounded-admin-control border border-border-strong px-3 text-body-s font-medium text-text-default hover:bg-bg-page lg:h-admin-control"
          >
            {t.home}
          </Link>
        </div>
      </div>
    </AdminShell>
  );
}
