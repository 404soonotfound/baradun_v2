"use client";

import type { WarningItem } from "@baradun/contracts";
import { ExternalLink } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { ReasonBadge } from "@/components/reason-badge";
import { Sheet } from "@/components/ui/sheet";
import { ZoneName } from "@/components/zone-name";
import { kstStamp } from "@/lib/snapshot/clock";
import { useBadgeText } from "@/lib/snapshot/use-badge-text";
import { useMetaText } from "@/lib/snapshot/use-meta-text";
import { kmaOriginalUrl } from "@/lib/warning-link";
import {
  rememberSeen,
  sameWarning,
  type SeenWarning,
} from "@/lib/warning-seen";

// 특보 상세 시트 WARN (BRD-33 · 노션 2장 WARN, 결정 기록 11장 10/27 ④)
// 배지 + 특보 이름 + "기상청 발표 · 14:30에 확인" → 계약 칸(종류·단계·구역·발표·발효 시각) → '기상청 원문 보기' → 현장 우선 문구
// 발표문 원문 본문·구역 약도는 후속(계약 변경 없음). 종류·단계·시각은 문구 키, 구역은 기상청 영어 이름 표 또는 원문(BRD-48).
// 홈 '해상 특보' 행과 상세 사유 상자의 특보 항목이 함께 씀. 모바일 하단 시트 / PC 가운데 대화상자(Sheet)

export function WarningSheet({
  open,
  onClose,
  item,
  items,
  source,
  confirmedAt,
  stale,
  nowMs,
}: {
  open: boolean;
  onClose: () => void;
  item: WarningItem | null; // 보여줄 특보. 닫힌 뒤에도 내용이 사라지며 깜빡이지 않게 마지막 값을 넘겨도 됨
  items: readonly WarningItem[]; // 지금 받은 특보 목록. 열린 사이 새 조회에서 빠진 특보를 새로 확인한 것처럼 보이지 않게
  source: string | null; // 특보 확인 기관(예: 기상청)
  confirmedAt: string | null; // 특보 마지막 확인 시각
  stale: boolean; // 새 정보를 못 받는 중(B5) → 'HH:MM 확인 · 이후 확인 못 함'
  nowMs: number;
}) {
  const t = useTranslations();
  const { badgeText, confirmedUntilText } = useBadgeText();
  const { agencyText } = useMetaText();

  const label = item
    ? ({ kind: "warning", type: item.type, level: item.level } as const)
    : null;
  const agency = source ? agencyText(source) : null;
  // 이 특보가 목록에 마지막으로 있던 확인 시각을 기억함(이전 렌더 값으로 갱신하는 React 파생 상태 방식)
  const [seen, setSeen] = useState<SeenWarning | null>(null);
  const nextSeen = rememberSeen(seen, item, items, confirmedAt);
  if (nextSeen !== seen) setSeen(nextSeen);
  // 열 때 고른 특보가 지금 목록에 없으면(해제·단계 변경·조회 실패) 지금 확인 시각을 붙이지 않고
  // 마지막으로 목록에 있던 시각으로 'HH:MM 확인 · 이후 확인 못 함'
  const listed =
    item !== null && items.some((other) => sameWarning(other, item));
  const seenAt = nextSeen?.confirmedAt ?? null;
  const time = kstStamp(seenAt, nowMs);
  // 확인 줄: live면 "기상청 발표 · 14:30에 확인", B5·시각 모름이면 'HH:MM 확인 · 이후 확인 못 함'
  const checked =
    stale || !listed || !time
      ? confirmedUntilText(seenAt, nowMs)
      : agency
        ? t("warningSheet.checked", { source: agency, time })
        : null;

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={label ? badgeText(label) : t("warningSheet.title")}
    >
      {item && label && (
        <div className="flex flex-col gap-4 pb-2">
          <div className="flex flex-col gap-1.5">
            <ReasonBadge label={label} />
            {checked && (
              <p className="text-caption text-text-muted">{checked}</p>
            )}
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 rounded-input bg-bg-subtle px-4 py-3 text-body-s">
            <dt className="text-text-muted">{t("warningSheet.type")}</dt>
            <dd className="text-text-default">
              {t(`warning.type.${item.type}`)}
            </dd>
            <dt className="text-text-muted">{t("warningSheet.level")}</dt>
            {/* 영어 단계 문구는 이름 뒤에 붙는 소문자("advisory")라 칸에서는 첫 글자만 대문자 */}
            <dd className="text-text-default first-letter:uppercase">
              {t(`warning.level.${item.level}`)}
            </dd>
            <dt className="text-text-muted">{t("warningSheet.zone")}</dt>
            <dd className="text-text-default">
              {/* 번역표에 없는 구역은 원문 그대로. 한국어가 아닌 화면은 원문이라고 알림(9.1) */}
              <ZoneName zone={item} block />
            </dd>
            <dt className="text-text-muted">{t("warningSheet.published")}</dt>
            <dd className="text-text-default">
              {kstStamp(item.publishedAt, nowMs) ?? "–"}
            </dd>
            <dt className="text-text-muted">{t("warningSheet.effective")}</dt>
            <dd className="text-text-default">
              {kstStamp(item.effectiveFrom, nowMs) ?? "–"}
            </dd>
          </dl>
          <a
            href={kmaOriginalUrl(item.type)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-touch items-center gap-1.5 self-start text-body-s font-bold text-brand-default underline"
          >
            {t("warningSheet.original")}
            <ExternalLink aria-hidden="true" size={14} />
            <span className="sr-only"> ({t("warningSheet.newWindow")})</span>
          </a>
          <p className="border-t border-border-default pt-3 text-caption text-text-muted">
            {t("safety.finalCall")}
          </p>
        </div>
      )}
    </Sheet>
  );
}
