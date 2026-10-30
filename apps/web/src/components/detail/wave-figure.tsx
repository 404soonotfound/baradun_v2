"use client";

import { Clock, Pause, Play } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";

import { useReducedMotion } from "@/lib/motion";

// 파도 그림 A+B (BRD-32 · 노션 3장 WaveFigure). 파고·파주기를 몸 기준으로 짐작하게 하는 참고 그림(판단에 안 씀)
// 세로 축 0·1m·2m(1m = 50px) + 성인 기준선 무릎 0.5·허리 1.0·가슴 1.3m. 앞 물결 마루~골 = 실제 파고.
// 물결 간격 114px·뒤 물결(8.5초·11초)은 분위기용 고정값(실제 파장 아님, B2-파장). 파주기마다 한 간격 이동.
// 부표(x=150)는 앞 물결을 따라 오르내리고 기울기는 경사의 80%. 2m 넘는 파고는 축을 늘리지 않고 위를 자름
// 동작 줄이기(기기 설정·설정의 화면 움직임 끔)·일시정지·파주기 없음 → 정지 화면
// 색·자리는 Figma 220:3659(BRD-129): 물은 축~기준선 끝(WATER_R) 안에만, 기준선 이름은 그 오른쪽 바깥

const W = 320;
const H = 168;
const AXIS_X = 34;
const WATER_R = 246; // 물·기준선 오른쪽 끝(Figma 77%)
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
  const reduce = useReducedMotion();
  const [paused, setPaused] = useState(false);
  const front = useRef<SVGPathElement>(null);
  const frontArea = useRef<SVGPathElement>(null);
  const backs = useRef<(SVGPathElement | null)[]>([]);
  const buoy = useRef<SVGGElement>(null);
  const clipId = useId();
  const fillId = useId();

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
    // Figma 177:588: 그림 자리와 같은 면 · 높이 150 · 시계 아이콘 + 이유 한 줄
    return (
      <p className="flex h-[150px] flex-col items-center justify-center gap-2 rounded-[14px] bg-bg-subtle px-4 text-center text-body-s text-text-muted">
        <Clock aria-hidden="true" size={22} />
        {delayed ? t("delayed") : t("noValue")}
      </p>
    );
  }

  const label =
    period === null
      ? t("labelNoPeriod", { height })
      : t("label", { height, period });

  return (
    // 모바일은 그림과 설명 사이 12(카드 간격), PC는 6(Figma 183:838)
    <figure className="flex flex-col gap-3 lg:gap-1.5">
      {/* Figma wf: 옅은 면 · 반경 14 · 안쪽 위 8 · 옆 6 · 아래 4 */}
      <div className="relative w-full rounded-[14px] bg-bg-subtle px-1.5 pt-2 pb-1">
        <svg
          role="img"
          aria-label={label}
          viewBox={`0 0 ${W} ${H}`}
          className="block h-auto w-full overflow-hidden"
        >
          <defs>
            <clipPath id={clipId}>
              <rect x={AXIS_X} y={0} width={WATER_R - AXIS_X} height={H} />
            </clipPath>
            <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
              <stop
                offset="0"
                className="[stop-color:var(--color-wave-front-top)]"
              />
              <stop
                offset="1"
                className="[stop-color:var(--color-wave-front-bottom)]"
              />
            </linearGradient>
          </defs>
          {/* 기준선(성인 평균 키). 물결 뒤에 그림 */}
          {GUIDES.map((guide) => (
            <line
              key={guide.key}
              x1={AXIS_X}
              x2={WATER_R}
              y1={yOf(guide.m)}
              y2={yOf(guide.m)}
              strokeDasharray="3 3"
              className="stroke-wave-guide"
            />
          ))}
          <g clipPath={`url(#${clipId})`}>
            {/* 뒤 물결 2겹(분위기용) */}
            {BACK.map((back, index) => (
              <path
                key={back.seconds}
                ref={(node) => {
                  backs.current[index] = node;
                }}
                className={
                  index === 0 ? "fill-wave-back-far" : "fill-wave-back-near"
                }
              />
            ))}
            {/* 앞 물결(채움 + 옅은 흰 마루선) + 부표 */}
            <path ref={frontArea} fill={`url(#${fillId})`} />
            <path
              ref={front}
              fill="none"
              strokeWidth={1.4}
              strokeOpacity={0.6}
              className="stroke-white"
            />
            {/* 바닥 물방울 3개(장식) */}
            {[0.24, 0.5, 0.76].map((at) => (
              <circle
                key={at}
                cx={AXIS_X + (WATER_R - AXIS_X) * at}
                cy={H - 5}
                r={1.5}
                className="fill-white"
              />
            ))}
            <g ref={buoy}>
              {/* 원점 = 물 표면. Figma 부표 21×31(돛대 · 몸통 · 흰 띠 · 아래 몸통) */}
              <rect
                x={-1.5}
                y={-22}
                width={3}
                height={8.5}
                className="fill-text-body"
              />
              <path
                d="M-7.6 -13.5H7.6L4.8 -3H-4.8Z"
                className="fill-wave-buoy"
              />
              <path
                d="M-10.5 -3H10.5L8.6 2.7H-8.6Z"
                className="fill-bg-surface"
              />
              <path
                d="M-8.6 2.7H8.6L5.2 9.4H-5.2Z"
                className="fill-wave-buoy"
              />
            </g>
          </g>
          {/* 기준선 이름(물결 오른쪽 바깥, Figma '가슴 1.3m') */}
          {GUIDES.map((guide) => (
            <text
              key={guide.key}
              x={WATER_R + 4}
              y={yOf(guide.m) + 3.5}
              className="fill-text-body text-[10px]"
            >
              {t("guideLabel", {
                name: t(guide.key),
                value: guide.m.toFixed(1),
              })}
            </text>
          ))}
          {/* 세로 축 + 눈금 + 파고 띠 */}
          <line
            x1={AXIS_X}
            x2={AXIS_X}
            y1={yOf(TOP_M)}
            y2={ZERO_Y}
            className="stroke-wave-guide"
          />
          {[0, 1, 2].map((m) => (
            <g key={m}>
              <line
                x1={AXIS_X - 4}
                x2={AXIS_X}
                y1={yOf(m)}
                y2={yOf(m)}
                className="stroke-wave-guide"
              />
              <text
                x={AXIS_X - 8}
                y={yOf(m) + 3.5}
                textAnchor="end"
                className="fill-text-muted text-[9.5px]"
              >
                {m === 0 ? "0" : `${m}m`}
              </text>
            </g>
          ))}
          <rect
            x={AXIS_X + 2}
            y={ZERO_Y - shown * PX_PER_M}
            width={5.7}
            height={shown * PX_PER_M}
            rx={1.9}
            className="fill-brand-default opacity-35"
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
        {/* 일시정지(44px, Figma 흰 원 · 아이콘 19). 움직일 수 없는 경우(동작 줄이기·파주기 없음)에는 두지 않음 */}
        {period !== null && !reduce && (
          <button
            type="button"
            aria-pressed={paused}
            aria-label={t("pause")}
            onClick={() => setPaused((value) => !value)}
            className="absolute top-1.5 right-1.5 flex size-touch items-center justify-center rounded-full bg-bg-surface text-brand-default"
          >
            {paused ? (
              <Play aria-hidden="true" size={19} className="fill-current" />
            ) : (
              <Pause aria-hidden="true" size={19} className="fill-current" />
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
