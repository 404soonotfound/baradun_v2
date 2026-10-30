"use client"; // 다시 시도(비동기 클릭)·포커스 이동을 쓰므로 브라우저 부품

import {
  CircleQuestionMark,
  Clock,
  FileWarning,
  RotateCw,
  WifiOff,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";

import { Banner } from "@/components/ui/banner";
import type { BeachSummary } from "@/lib/beach-summary";
import { localizedPath, type Locale } from "@/lib/i18n";
import { joinMeta } from "@/lib/meta-join";
import { shownDataTime, type DataSituation } from "@/lib/situation";
import type { SnapshotState } from "@/lib/snapshot/store";
import { getSnapshotState, refreshSnapshot } from "@/lib/snapshot/use-snapshot";

// 상황 배너 (BRD-28 · 노션 2장 HOME 3, 3장 Banner). 홈·탐색·상세가 함께 씀
// 어떤 배너를 보일지는 lib/situation.ts(pickSituation)가 정하고, 여기서는 그리기만 함
// 문구는 무슨 일(제목) → 영향 → 다음 행동 순서
//   오프라인(회색): 인터넷에 연결되어 있지 않아요 / 14:30 정보를 보여주고 있어요 · 연결되면 다시 확인해요
//   지원 밖 형식(회색): 새 데이터 형식을 읽지 못했어요 / 모든 해변을 '확인 못 함'으로 보여줘요 · 새로고침
//   불러오기 실패(빨강): 새 정보를 불러오지 못했어요 / 14:30 정보를 보여주고 있어요 · 다시 시도
//   확인된 판단 없음(회색, BRD-38·결정 1): 현재 확인 가능한 판단 정보가 없어요 / 마지막 확인 14:05 · 새 정보가 들어오면 다시 확인해요
//     원인(출처 장애)은 단정하지 않고 확인된 영향만 알림. publisher가 명시적 장애 신호를 주면 그 신호로 바꿈
//   관측 지연(앰버): ○○ 파고 측정이 늦어지고 있어요 / 지금 상태를 판단하지 못했어요 · … → 누르면 그 해변 상세
// '위치 없이 보는 중'은 화면마다 달라서 부르는 쪽이 그림

// Vue: props: { locale, situation, snapshot } + this.$emit("retrySucceeded")
export function SituationBanner({
  locale,
  situation,
  snapshot,
  onRetrySucceeded,
}: {
  locale: Locale;
  situation: DataSituation<Pick<BeachSummary, "name" | "slug">>;
  snapshot: Pick<SnapshotState, "phase" | "manifest" | "statuses" | "nowMs">;
  // 다시 시도가 성공해 배너가 사라질 때 포커스를 옮길 곳(예: 화면 제목)
  onRetrySucceeded?: () => void;
}) {
  const t = useTranslations("situationBanner");
  const retryRef = useRef<HTMLButtonElement>(null);
  // [1] 다시 시도 중인지 · 화면 읽기에 조용히 알릴 결과 (Vue: data)
  const [retrying, setRetrying] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  // 배너가 바뀌면 지난 알림을 지움(Vue: watch(situation.kind)). 그리는 중 상태 맞추기 패턴
  const kind = situation?.kind ?? null;
  const [shownKind, setShownKind] = useState(kind);
  if (kind !== shownKind) {
    setShownKind(kind);
    setAnnouncement("");
  }

  // [2] 누르면 다시 조회. 불러오기 실패 배너가 사라지면(성공·오프라인·형식 오류 등) 포커스를 옮기고,
  // 그대로 실패면 알림. 판정은 pickSituation의 '불러오기 실패' 조건과 같게 둠
  async function retry() {
    if (retrying) return;
    const hadFocus = document.activeElement === retryRef.current;
    setRetrying(true);
    setAnnouncement("");
    try {
      await refreshSnapshot();
    } catch {
      // 실패는 아래에서 store 상태로 판단
    } finally {
      setRetrying(false);
    }
    const after = getSnapshotState();
    if (after.failedOnline && !after.live) {
      setAnnouncement(t("retryFailed"));
    } else if (hadFocus) {
      onRetrySucceeded?.();
    }
  }

  // [3] 영향: 지금 보여주는 정보의 시각. 받은 정보가 없으면 '아직 받은 정보가 없어요'
  // 형식을 못 읽은 뒤(오프라인이 먼저 보여도)는 해변이 모두 '확인 못 함'이라 지난 시각을 말하지 않음
  const time = shownDataTime(snapshot.manifest?.generatedAt, snapshot.nowMs);
  let dataText = t("noData");
  if (snapshot.phase === "schema_unsupported") {
    dataText = t("unsupportedBody");
  } else if (snapshot.statuses !== null) {
    dataText = time ? t("dataTime", { time }) : t("dataTimeUnknown");
  }

  // Vue: v-if / v-else-if 여러 갈래 → switch
  function banner() {
    if (situation === null) return null;
    switch (situation.kind) {
      case "offline":
        return (
          <Banner tone="gray" icon={<WifiOff size={16} />} title={t("offline")}>
            {joinMeta([dataText, t("offlineNext")])}
          </Banner>
        );
      case "unsupported":
        return (
          <Banner
            tone="gray"
            icon={<FileWarning size={16} />}
            title={t("unsupported")}
            action={
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="font-bold text-text-default underline"
              >
                {t("reload")}
              </button>
            }
          >
            {t("unsupportedBody")}
          </Banner>
        );
      case "failed":
        return (
          <Banner
            tone="red"
            icon={<RotateCw size={16} />}
            title={t("failed")}
            action={
              // disabled 대신 aria-disabled: 누르는 동안에도 포커스가 버튼에 남음
              <button
                ref={retryRef}
                type="button"
                onClick={() => void retry()}
                aria-disabled={retrying}
                className="font-bold text-text-default underline aria-disabled:no-underline aria-disabled:opacity-60"
              >
                {retrying ? t("retrying") : t("retry")}
              </button>
            }
          >
            {dataText}
          </Banner>
        );
      case "noConfirmed": {
        // 마지막 확인 시각 = 해변별 특보 마지막 확인 시각 중 가장 늦은 것(noConfirmedVerdict)
        const last = shownDataTime(situation.lastConfirmedAt, snapshot.nowMs);
        // 아이콘도 원인(끊김·장애)을 암시하지 않게 판단불가 배지와 같은 물음표(결정 1)
        // 모든 해변에 영향을 주는 안내라 큰 배너(Figma L13 188:270, BRD-129)
        return (
          <Banner
            tone="gray"
            size="l"
            icon={<CircleQuestionMark size={18} />}
            title={t("noConfirmed")}
          >
            {joinMeta([
              last
                ? t("noConfirmedTime", { time: last })
                : t("noConfirmedTimeUnknown"),
              t("noConfirmedNext"),
            ])}
          </Banner>
        );
      }
      case "delayed":
        return (
          <Banner
            tone="amber"
            icon={<Clock size={16} />}
            title={
              situation.more > 0
                ? t("delayedMore", {
                    name: situation.first.name,
                    count: situation.more,
                  })
                : t("delayed", { name: situation.first.name })
            }
            href={localizedPath(locale, `/spots/${situation.first.slug}/`)}
          >
            {t("delayedBody")}
          </Banner>
        );
    }
  }

  return (
    <>
      {banner()}
      {/* 다시 시도 결과 알림. 배너가 바뀌어도 남도록 항상 그려 둠 */}
      <p role="status" className="sr-only">
        {announcement}
      </p>
    </>
  );
}
