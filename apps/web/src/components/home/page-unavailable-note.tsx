"use client"; // 주소의 표식(?unavailable=1)을 브라우저에서 읽으므로 브라우저 부품

import { useEffect, useState, useSyncExternalStore } from "react";
import { useTranslations } from "next-intl";

import { joinMeta } from "@/lib/meta-join";
import {
  hasUnavailableMark,
  withoutUnavailableMark,
} from "@/lib/page-unavailable";

// 열지 못한 화면 안내 (BRD-106 결정 29, lib/page-unavailable.ts)
// 연결이 없어 상세·검색 등을 열지 못하고 서비스 워커가 홈으로 보냈을 때만 보임
// 문구: 무슨 일(그 화면을 열지 못했어요) → 영향(홈·탐색·즐겨찾기·설정만 열림) → 다음 행동(연결 확인 뒤 다시 열기)
// 상황 배너(오프라인 등, 화면당 하나)와 따로 그 아래에 둠. 배너 고르기 규칙은 바꾸지 않음

const noSubscribe = () => () => {};

export function PageUnavailableNote() {
  const t = useTranslations("home.unavailable");
  // 서버(정적 HTML)는 주소를 몰라 false, 브라우저는 지금 주소
  const marked = useSyncExternalStore(
    noSubscribe,
    () => hasUnavailableMark(window.location.search),
    () => false,
  );
  // 표식을 지운 뒤에도 이 화면에 있는 동안은 안내를 남김(그리는 중 상태 맞추기 패턴)
  const [shown, setShown] = useState(false);
  if (marked && !shown) setShown(true);

  // 표식을 주소에서 지움(새로고침·공유 때 다시 뜨지 않게)
  useEffect(() => {
    if (!marked) return;
    window.history.replaceState(
      window.history.state,
      "",
      withoutUnavailableMark(window.location.href),
    );
  }, [marked]);

  const body = joinMeta([t("impact"), t("next")]);
  return (
    <>
      {/* 화면 읽기용. 늘 그려 둬야 글이 들어올 때 읽어 줌(SituationBanner 알림과 같은 방식, 자리를 차지하지 않음) */}
      <p role="status" className="sr-only">
        {shown ? `${t("title")}. ${body}` : ""}
      </p>
      {/* 보이는 안내. 같은 내용을 두 번 읽지 않게 화면 읽기에서는 뺌 */}
      {shown && (
        <p
          aria-hidden="true"
          className="rounded-card bg-bg-surface px-4 py-3 text-body-s text-text-body shadow-card"
        >
          <strong className="block font-bold text-text-default">
            {t("title")}
          </strong>
          {body}
        </p>
      )}
    </>
  );
}
