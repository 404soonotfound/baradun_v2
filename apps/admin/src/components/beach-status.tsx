"use client";

import {
  CircleCheck,
  CircleQuestionMark,
  Clock,
  LoaderCircle,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import type { OpsResult } from "@/lib/auth/ops-fetch";
import { useAuthSession, useSessionSnapshot } from "@/lib/auth/provider";
import {
  badgeTone,
  fetchPublished,
  parsePublished,
  type BadgeLabel,
  type BadgeTone,
  type BeachDisplay,
  type PublishedView,
} from "@/lib/beaches";
import { kstDateTime } from "@/lib/inquiries";
import { fill, messages } from "@/lib/messages";
import { Button, Notice } from "./ui";

// 해변 관리의 지금 표시 상태 (BRD-150, 화면 ADM-BCH)
// - 운영 API가 게시본 status.json에서 옮긴 분류·사유를 그대로 보여 줌(G1). 배지는 실제 사유 먼저 + 아이콘 + 분류 이름
// - 색만으로 나누지 않음: 글자(사유·분류)와 아이콘, 판단불가는 점선 테두리
// - 못 받으면 모든 해변을 판단불가 계열 '확인 못 함'(특보 없음처럼 보이지 않게)
//   이때 분류 이름(판단불가)은 붙이지 않음: 앱이 무엇으로 게시했는지 모르므로 '게시본을 받지 못했어요'라고만 씀

const t = messages.beaches;

const TONE: Record<BadgeTone, string> = {
  clear: "border-transparent bg-status-clear-bg text-status-clear-fg",
  blocked: "border-transparent bg-status-blocked-bg text-status-blocked-fg",
  unknown:
    "border-dashed border-status-unknown-border bg-status-unknown-bg text-status-unknown-fg",
  stale:
    "border-dashed border-status-stale-border bg-status-stale-bg text-status-stale-fg",
};

const ICON: Record<BadgeTone, ReactNode> = {
  clear: <CircleCheck size={14} aria-hidden="true" />,
  blocked: <TriangleAlert size={14} aria-hidden="true" />,
  unknown: <CircleQuestionMark size={14} aria-hidden="true" />,
  stale: <Clock size={14} aria-hidden="true" />,
};

export function labelText(label: BadgeLabel): string {
  if (label.kind === "warning") {
    return fill(t.statusLabel.warning, {
      type: t.warningType[label.type],
      level: t.warningLevel[label.level],
    });
  }
  return t.statusLabel[label.kind];
}

function Badge({ label }: { label: BadgeLabel }) {
  const tone = badgeTone(label);
  return (
    <span
      className={`inline-flex h-6 shrink-0 items-center gap-1 rounded-admin-badge border-[1.5px] px-1.5 text-label-s font-semibold whitespace-nowrap ${TONE[tone]}`}
    >
      {ICON[tone]}
      {labelText(label)}
    </span>
  );
}

const UNCONFIRMED: BadgeLabel = { kind: "unconfirmed" };

// 배지 한 줄: 첫 사유 배지 + 분류 이름(+ 나머지 사유 수)
export function DisplayBadge({ display }: { display: BeachDisplay }) {
  if (display.kind === "loading") {
    return (
      <span className="inline-flex items-center gap-1 text-label-s text-text-muted">
        <LoaderCircle
          size={14}
          aria-hidden="true"
          className="motion-safe:animate-spin"
        />
        {t.statusLoading}
      </span>
    );
  }
  if (display.kind === "unconfirmed") {
    return (
      <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-1">
        <Badge label={UNCONFIRMED} />
        <span className="text-label-s text-text-muted">
          {display.why === "missing" ? t.statusMissing : t.statusNotLoaded}
        </span>
      </span>
    );
  }
  const [first, ...rest] = display.labels;
  return (
    <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-1">
      <Badge label={first} />
      {display.category !== "clear" && (
        <span className="text-label-s text-text-muted">
          {t.category[display.category]}
          {rest.length > 0 &&
            ` · ${fill(t.moreReasons, { count: rest.length })}`}
        </span>
      )}
    </span>
  );
}

// 상세: 사유 모두(범위·기관·발표·관측 시각). 계약 밖 값(글자가 아닌 칸)은 그리지 않음
const textOf = (v: unknown): string | null =>
  typeof v === "string" && v !== "" ? v : null;
const timeOf = (v: unknown): string | null =>
  typeof v === "string" && !Number.isNaN(Date.parse(v)) ? v : null;

export function ReasonList({ display }: { display: BeachDisplay }) {
  if (display.kind !== "published" || display.category === "clear") {
    return null;
  }
  return (
    <ul className="flex flex-col gap-1.5">
      {display.labels.map((label, i) => {
        const reason = display.reasons[i];
        const scope = textOf(reason?.scope);
        const source = textOf(reason?.source);
        const at = timeOf(reason?.at);
        return (
          <li
            key={i}
            className="flex flex-wrap items-center gap-x-2 gap-y-1 text-body-s text-text-body"
          >
            <Badge label={label} />
            {scope && <span>{scope}</span>}
            {source && <span className="text-text-muted">{source}</span>}
            {at && (
              <span className="text-text-muted">
                {fill(t.reasonAt, { time: kstDateTime(at) })}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

// 게시본 상태 읽기. 다시 로그인하면(generation이 늚) 저절로 다시 읽음
// 결과: "loading" · PublishedView · null(모양이 틀림) · 실패 응답
export function usePublished(): {
  readonly published: PublishedView | null | "loading";
  readonly failure: Extract<OpsResult<unknown>, { ok: false }> | null;
  readonly retry: () => void;
} {
  const session = useAuthSession();
  const snapshot = useSessionSnapshot();
  const generation = snapshot.status === "signed_out" ? 0 : snapshot.generation;
  const [attempt, setAttempt] = useState(0);
  const key = `${attempt}|${generation}`;
  const [loaded, setLoaded] = useState<{
    key: string;
    result: OpsResult<unknown>;
  } | null>(null);

  useEffect(() => {
    let live = true;
    void fetchPublished(() => session.accessToken()).then((result) => {
      if (live) setLoaded({ key, result });
    });
    return () => {
      live = false;
    };
  }, [session, key]);

  const result = loaded?.key === key ? loaded.result : null;
  return {
    published:
      result === null
        ? "loading"
        : result.ok
          ? parsePublished(result.body)
          : null,
    failure: result && !result.ok ? result : null,
    retry: () => setAttempt((n) => n + 1),
  };
}

// 상태를 못 받았을 때 맨 위 알림: 무슨 일 → 영향 → 다음 행동. 받았으면 그리지 않음
export function PublishedAlert({
  state,
}: {
  state: ReturnType<typeof usePublished>;
}) {
  const { published, failure, retry } = state;
  if (published === "loading" || published?.available) return null;
  if (failure?.code === "reauth") {
    return <Notice tone="warn" title={t.reauth} role="alert" />;
  }
  return (
    <Notice tone="fail" title={t.statusUnavailableTitle} role="alert">
      <p>{t.statusUnavailableBody}</p>
      {failure && "requestId" in failure && failure.requestId && (
        <p>{fill(t.requestId, { id: failure.requestId })}</p>
      )}
      <Button variant="secondary" size="small" className="mt-2" onClick={retry}>
        {t.retry}
      </Button>
    </Notice>
  );
}
