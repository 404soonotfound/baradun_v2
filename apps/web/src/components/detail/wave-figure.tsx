"use client";

import { Pause, Play } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

// 파도 그림 A+B (BRD-32 · 노션 3장 WaveFigure). 파고·파주기를 몸 기준으로 짐작하게 하는 참고 그림(판단에 안 씀)
// 세로 축 0·1m·2m(1m = 50px) + 성인 기준선 무릎 0.5·허리 1.0·가슴 1.3m. 앞 물결 마루~골 = 실제 파고.
// 물결 간격 114px·뒤 물결(8.5초·11초)은 분위기용 고정값(실제 파장 아님, B2-파장). 파주기마다 한 간격 이동.
// 부표(x=150)는 앞 물결을 따라 오르내리고 기울기는 경사의 80%. 2m 넘는 파고는 축을 늘리지 않고 위를 자름
// 동작 줄이기·일시정지·파주기 없음 → 정지 화면

const W = 320;
const H = 168;
const AXIS_X = 34;
const ZERO_Y = 146; // 0m
const PX_PER_M = 50;
const TOP_M = 2; // 축 위 끝
const WAVELENGTH = 114;
const BUOY_X = 150;
const BACK = [
  { wavelength: 170, seconds: 8.5, amplitude: 0.55, rise: 0.18 },
  { wavelength: 230, seconds: 11, amplitude: 0.4, rise: 0.32 },
];
const GUIDES = [
  { m: 0.5, key: "knee" },
  { m: 1.0, key: "waist" },
  { m: 1.3, key: "chest" },
] as const;

const yOf = (m: number) => ZERO_Y - m * PX_PER_M;

// 물결 선: y = 가운데 - 진폭·sin(2π(x - 이동)/간격)
function wavePath(mid: number, amp: number, wavelength: number, shift: number) {
  let d = "";
  for (let x = AXIS_X; x <= W; x += 4) {
    const y = mid - amp * Math.sin((2 * Math.PI * (x - shift)) / wavelength);
    d += `${d ? "L" : "M"}${x} ${y.toFixed(2)}`;
  }
  return d;
}
const areaPath = (line: string) => `${line}L${W} ${H}L${AXIS_X} ${H}Z`;

function subscribeReducedMotion(onChange: () => void) {
  const query = window.matchMedia("(prefers-reduced-motion: reduce)");
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}
const reducedMotion = () =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function WaveFigure({
  height,
  period: rawPeriod,
  delayed = false,
}: {
  height: number | null; // 파고(m). null = 값 없음 → 그리지 않음
  period: number | null; // 파주기(초). null이면 움직이지 않음
  // 파고가 늦어져 숨긴 경우(관측 지연). 값이 없는 경우와 문구를 나눔(지연과 결측을 섞지 않음)
  delayed?: boolean;
}) {
  const t = useTranslations("detail.figure");
  // 0 이하 파주기는 움직일 수 없어 파주기 없음과 같게 둠('0초마다 오르내려요'·쓸모없는 일시정지 버튼이 보이지 않게)
  const period = rawPeriod !== null && rawPeriod > 0 ? rawPeriod : null;
  const reduce = useSyncExternalStore(
    subscribeReducedMotion,
    reducedMotion,
    () => true,
  );
  const [paused, setPaused] = useState(false);
  const front = useRef<SVGPathElement>(null);
  const frontArea = useRef<SVGPathElement>(null);
  const backs = useRef<(SVGPathElement | null)[]>([]);
  const buoy = useRef<SVGGElement>(null);

  const shown = height === null ? 0 : Math.min(height, TOP_M);
  const amp = (shown * PX_PER_M) / 2;
  const mid = ZERO_Y - amp;
  const moving = height !== null && period !== null && !reduce && !paused;

  // 한 장면 그리기. t = 경과 초
  useEffect(() => {
    if (height === null) return;
    const draw = (seconds: number) => {
      const shift = period ? ((seconds / period) * WAVELENGTH) % WAVELENGTH : 0;
      const line = wavePath(mid, amp, WAVELENGTH, shift);
      front.current?.setAttribute("d", line);
      frontArea.current?.setAttribute("d", areaPath(line));
      BACK.forEach((back, index) => {
        const backShift =
          ((seconds / back.seconds) * back.wavelength) % back.wavelength;
        backs.current[index]?.setAttribute(
          "d",
          areaPath(
            wavePath(
              mid - amp * back.rise,
              amp * back.amplitude,
              back.wavelength,
              backShift,
            ),
          ),
        );
      });
      const phase = (2 * Math.PI * (BUOY_X - shift)) / WAVELENGTH;
      const y = mid - amp * Math.sin(phase);
      const slope = (-amp * 2 * Math.PI * Math.cos(phase)) / WAVELENGTH;
      const angle = ((Math.atan(slope) * 180) / Math.PI) * 0.8;
      buoy.current?.setAttribute(
        "transform",
        `translate(${BUOY_X} ${y.toFixed(2)}) rotate(${angle.toFixed(1)})`,
      );
    };
    if (!moving) {
      draw(0);
      return;
    }
    let frame = 0;
    const start = performance.now();
    const tick = (now: number) => {
      draw((now - start) / 1000);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [height, period, mid, amp, moving]);

  if (height === null) {
    return (
      <p className="flex h-[120px] items-center justify-center rounded-input border border-dashed border-border-strong px-4 text-center text-body-s text-text-muted">
        {delayed ? t("delayed") : t("noValue")}
      </p>
    );
  }

  const label =
    period === null
      ? t("labelNoPeriod", { height })
      : t("label", { height, period });

  return (
    <figure className="flex flex-col gap-2">
      <div className="relative w-full max-w-[400px]">
        <svg
          role="img"
          aria-label={label}
          viewBox={`0 0 ${W} ${H}`}
          className="block h-auto w-full overflow-hidden rounded-input bg-bg-subtle"
        >
          {/* 뒤 물결 2겹(분위기용) */}
          {BACK.map((back, index) => (
            <path
              key={back.seconds}
              ref={(node) => {
                backs.current[index] = node;
              }}
              className="fill-brand-weak"
            />
          ))}
          {/* 기준선(성인 평균 키) */}
          {GUIDES.map((guide) => (
            <g key={guide.key}>
              <line
                x1={AXIS_X}
                x2={W - 34}
                y1={yOf(guide.m)}
                y2={yOf(guide.m)}
                strokeDasharray="4 4"
                className="stroke-border-strong"
              />
            </g>
          ))}
          {/* 앞 물결 + 부표 */}
          <path ref={frontArea} className="fill-chart opacity-20" />
          <path
            ref={front}
            fill="none"
            strokeWidth={2.5}
            className="stroke-chart"
          />
          <g ref={buoy}>
            <line
              y1={-16}
              y2={-7}
              strokeWidth={2}
              className="stroke-text-default"
            />
            <circle
              r={7}
              className="fill-banner-amber-icon-fg stroke-text-default"
              strokeWidth={1.5}
            />
          </g>
          {/* 기준선 이름: 물결 위에 그리고 바탕색 테두리를 둘러 가려지지 않게 */}
          {GUIDES.map((guide) => (
            <text
              key={guide.key}
              x={W - 4}
              y={yOf(guide.m) + 4}
              textAnchor="end"
              paintOrder="stroke"
              strokeWidth={3}
              className="fill-text-muted stroke-bg-subtle text-[10px]"
            >
              {t(guide.key)}
            </text>
          ))}
          {/* 세로 축 + 파고 띠 */}
          <line
            x1={AXIS_X}
            x2={AXIS_X}
            y1={yOf(TOP_M)}
            y2={ZERO_Y}
            className="stroke-border-strong"
          />
          {[0, 1, 2].map((m) => (
            <text
              key={m}
              x={AXIS_X - 6}
              y={yOf(m) + 4}
              textAnchor="end"
              className="fill-text-muted text-[10px]"
            >
              {m === 0 ? "0" : `${m}m`}
            </text>
          ))}
          <rect
            x={AXIS_X + 2}
            y={ZERO_Y - shown * PX_PER_M}
            width={5}
            height={shown * PX_PER_M}
            rx={2}
            className="fill-chart"
          />
          {height > TOP_M && (
            <text
              x={AXIS_X + 12}
              y={yOf(TOP_M) - 8}
              paintOrder="stroke"
              strokeWidth={3}
              className="fill-text-default stroke-bg-subtle text-[11px] font-bold"
            >
              {t("over2m")}
            </text>
          )}
        </svg>
        {/* 일시정지(44px). 움직일 수 없는 경우(동작 줄이기·파주기 없음)에는 두지 않음 */}
        {period !== null && !reduce && (
          <button
            type="button"
            aria-pressed={paused}
            aria-label={t("pause")}
            onClick={() => setPaused((value) => !value)}
            className="absolute top-1 right-1 flex size-touch items-center justify-center rounded-full bg-bg-surface text-text-default shadow-card"
          >
            {paused ? (
              <Play aria-hidden="true" size={18} />
            ) : (
              <Pause aria-hidden="true" size={18} />
            )}
          </button>
        )}
      </div>
      <figcaption className="text-caption text-text-muted">
        {period === null
          ? t("captionNoPeriod", { height })
          : t("caption", { height, period })}
      </figcaption>
    </figure>
  );
}
