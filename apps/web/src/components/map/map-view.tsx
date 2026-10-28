"use client"; // 화면에 보일 때 지도를 불러오고 브라우저 그래픽(WebGL)으로 그리므로 브라우저 부품

import { MapPinOff, Minus, Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useReducer, useRef, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";
import type { Locale } from "@/lib/i18n";
import { FIT_OPTIONS, type LngLatBox } from "@/lib/map/bounds";
import type { MapHandle } from "@/lib/map/engine";
import { prefersReducedMotion } from "@/lib/motion";
import { initialMapLoad, mapLoadReducer } from "@/lib/map/map-load";
import { MAP_ATTRIBUTIONS } from "@/lib/map/style";

// 지도 틀 (BRD-65 · 결정 D8, 아키텍처 9장 '지도 불러오기'·16.4.3·16.4.5)
// - 지도 자리가 화면에 보일 때만 MapLibre를 불러옴(첫 화면에 넣지 않음. display:none이면 시작하지 않음)
// - 실패(스타일·타일·WebGL 오류, 또는 15초 안에 바다가 그려지지 않음)하면 지도 자리에만 '목록으로 볼 수 있어요' + 다시 시도
// - 출처 표기는 지도 아래 우리 줄(링크라 키보드·화면 읽기 가능, 토큰 색이라 다크에서도 읽힘)
// - 사용자 위치는 받지도 쓰지도 않음. 처음 범위는 넘겨받은 해변 범위(bounds)
// - 다 그린 뒤에만 overlay(마커·범례·카드, BRD-30)를 지도 위에 그림
export function MapView({
  locale,
  bounds,
  overlay,
  onShowList,
  className,
}: {
  locale: Locale;
  bounds: LngLatBox; // 처음 보이는 범위
  overlay?: (api: MapHandle) => ReactNode;
  // 실패 화면의 '목록으로 보기'(모바일 지도 보기). PC(lg)는 목록이 옆에 있어 버튼을 숨김
  onShowList?: () => void;
  className?: string;
}) {
  const t = useTranslations("map");
  const frameRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<MapHandle | null>(null);
  const [load, dispatch] = useReducer(mapLoadReducer, initialMapLoad);
  // 다 그린 지도(overlay에 넘김). 시도마다 그 시도의 지도로 바뀜
  const [api, setApi] = useState<MapHandle | null>(null);
  // 지도를 만들 때 쓸 최신 값. 바뀌어도 이미 만든 지도를 다시 만들지 않음
  const latest = useRef({ locale, bounds, canvasLabel: t("canvas") });
  useEffect(() => {
    latest.current = { locale, bounds, canvasLabel: t("canvas") };
  });

  // [1] 처음 화면에 보이면 시작. 보이지 않는 동안(숨긴 열·스크롤 밖)은 아무것도 받지 않음
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        dispatch({ type: "visible" });
        observer.disconnect();
      }
    });
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);

  // [2] 시도마다 지도를 새로 만듦. 다시 시도하면 시도 번호가 바뀌어 지난 지도를 지우고 새로 만듦
  const attempt = load.attempt;
  useEffect(() => {
    if (attempt === 0) return;
    let cancelled = false;
    (async () => {
      const container = canvasRef.current;
      if (!container) return;
      const uiFont = await readyUiFont(container);
      // 지도 코드는 여기서 처음 받음(첫 화면 파일에 넣지 않음)
      let engine: typeof import("@/lib/map/engine");
      try {
        engine = await import("@/lib/map/engine");
      } catch {
        // 파일을 받지 못함(오프라인 등)
        if (!cancelled) dispatch({ type: "failed", attempt });
        return;
      }
      if (cancelled) return;
      const { locale, bounds, canvasLabel } = latest.current;
      const handle = engine.createMap({
        container,
        locale,
        bounds,
        uiFont,
        reducedMotion: prefersReducedMotion(),
        canvasLabel,
        onReady: () => {
          if (!cancelled) setApi(handle);
          dispatch({ type: "ready", attempt });
        },
        onFailed: () => dispatch({ type: "failed", attempt }),
      });
      handleRef.current = handle;
    })();
    return () => {
      cancelled = true;
      handleRef.current?.destroy();
      handleRef.current = null;
    };
  }, [attempt]);

  // [3] 실패하면 지도를 지움(더 받지 않음). 다시 시도 때 [2]가 새로 만듦
  useEffect(() => {
    if (load.phase !== "failed") return;
    handleRef.current?.destroy();
    handleRef.current = null;
  }, [load.phase]);

  // [4] 다 그린 뒤 범위가 바뀌면(활동·지역 변경) 그 범위로 옮김. 같은 범위면 그대로
  const boundsKey = bounds.flat().join(",");
  const ready = load.phase === "ready";
  useEffect(() => {
    if (!ready) return;
    handleRef.current?.map.fitBounds(latest.current.bounds, {
      ...FIT_OPTIONS,
      animate: !prefersReducedMotion(),
    });
  }, [ready, boundsKey]);

  function zoom(direction: 1 | -1) {
    const map = handleRef.current?.map;
    if (!map) return;
    const options = { animate: !prefersReducedMotion() };
    if (direction === 1) map.zoomIn(options);
    else map.zoomOut(options);
  }

  const failed = load.phase === "failed";

  return (
    <section
      aria-label={t("label")}
      className={cn(
        "flex flex-col overflow-hidden rounded-card bg-bg-surface shadow-card",
        className,
      )}
    >
      <div ref={frameRef} className="relative min-h-0 flex-1 bg-bg-subtle">
        {/* MapLibre가 그리는 자리. 실패하면 숨김. MapLibre가 자기 틀에 position: relative를 붙여서 한 겹 감쌈 */}
        <div className={cn("absolute inset-0", failed && "hidden")}>
          <div ref={canvasRef} className="size-full" />
        </div>

        {(load.phase === "idle" || load.phase === "loading") && (
          <div
            role="status"
            className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-bg-subtle"
          >
            <Skeleton className="absolute inset-0 rounded-none" />
            <p className="relative rounded-full bg-bg-surface px-3 py-1.5 text-caption text-text-body shadow-card">
              {t("loading")}
            </p>
          </div>
        )}

        {failed && (
          // 무슨 일 → 영향 → 다음 행동. 목록·검색·상세는 그대로 동작(16.4.3 장애 격리)
          <div
            role="alert"
            className="absolute inset-0 flex flex-col items-center justify-center gap-2.5 px-6 text-center"
          >
            <span
              aria-hidden="true"
              className="flex size-[60px] items-center justify-center rounded-full bg-bg-surface text-text-muted"
            >
              <MapPinOff size={26} />
            </span>
            <p className="text-title-s text-text-default">
              {t("failed.title")}
            </p>
            <p className="text-caption text-text-body">{t("failed.body")}</p>
            <div className="mt-1.5 flex flex-wrap justify-center gap-2">
              <Button
                variant="secondary"
                onClick={() => dispatch({ type: "retry" })}
              >
                {t("failed.retry")}
              </Button>
              {/* PC(lg)는 목록이 옆에 늘 보여 숨김 */}
              {onShowList && (
                <Button
                  variant="secondary"
                  className="lg:hidden"
                  onClick={onShowList}
                >
                  {t("failed.showList")}
                </Button>
              )}
            </div>
          </div>
        )}

        {/* 마커·범례·카드(BRD-30). 확대·축소 버튼보다 앞에 둬서 버튼이 가려지지 않게 */}
        {ready && api && overlay?.(api)}

        {ready && (
          // 확대·축소. 손가락·마우스 휠·키보드(+/−)로도 됨. 44px 버튼
          <div className="absolute top-3 right-3 flex flex-col overflow-hidden rounded-button bg-bg-surface shadow-card">
            <button
              type="button"
              onClick={() => zoom(1)}
              aria-label={t("zoomIn")}
              className="flex size-touch items-center justify-center text-text-default hover:bg-bg-subtle"
            >
              <Plus aria-hidden="true" size={18} />
            </button>
            <button
              type="button"
              onClick={() => zoom(-1)}
              aria-label={t("zoomOut")}
              className="flex size-touch items-center justify-center border-t border-border-default text-text-default hover:bg-bg-subtle"
            >
              <Minus aria-hidden="true" size={18} />
            </button>
          </div>
        )}
      </div>

      {/* 출처 표기(OSM·OpenMapTiles·OpenFreeMap). 지도가 보이든 실패하든 같은 자리 */}
      <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 border-t border-border-default px-3 py-2 text-caption text-text-muted">
        <span className="sr-only">{t("attribution.label")}</span>
        {MAP_ATTRIBUTIONS.map((item) => (
          <a
            key={item.key}
            href={item.href}
            target="_blank"
            rel="noopener noreferrer"
            className="underline-offset-2 hover:underline"
          >
            {t(`attribution.${item.key}`)}
          </a>
        ))}
      </p>
    </section>
  );
}

// 한글 라벨 글꼴 = 화면 글꼴. 글꼴 파일이 아직 안 왔으면 받은 뒤 그림(다른 글꼴로 한 번 그려 굳지 않게)
// 3초 안에 못 받으면 그대로 진행(지도는 대체 글꼴로라도 보여 줌)
async function readyUiFont(element: HTMLElement): Promise<string> {
  const family = getComputedStyle(element).fontFamily;
  try {
    await Promise.race([
      Promise.all([
        document.fonts.load(`400 14px ${family}`, "가"),
        document.fonts.load(`700 14px ${family}`, "가"),
      ]),
      new Promise((resolve) => window.setTimeout(resolve, 3000)),
    ]);
  } catch {
    // 글꼴 확인을 못 해도 지도는 그림
  }
  return family;
}
