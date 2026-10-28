import { useSyncExternalStore } from "react";

import { MOTION_STORAGE_KEY } from "@/lib/display-init";

// 화면 움직임 (노션 2장 SET '화면 움직임 스위치': 끄면 파도·화면 애니메이션 정지, BRD-36)
// 기기의 '동작 줄이기'(prefers-reduced-motion)를 켰거나 이 스위치를 끄면 움직임을 줄임. 둘 중 하나라도면 줄임
// 고른 값은 이 기기에만 저장. 기본은 켜짐(값 "off"만 저장)
const REDUCE_QUERY = "(prefers-reduced-motion: reduce)";

// 그리기 전에 붙이는 스크립트(data-motion)와 저장 키는 lib/display-init.ts(서버 부품도 읽음)

let memory = true; // 스위치(켜짐 = 움직임 보임). 저장소를 못 쓰는 환경 대비
let writeFailed = false;
const listeners = new Set<() => void>();

function readSwitch(): boolean {
  if (writeFailed) return memory;
  try {
    return localStorage.getItem(MOTION_STORAGE_KEY) !== "off";
  } catch {
    return memory;
  }
}

function applyMotion(on: boolean) {
  const html = document.documentElement;
  if (on) html.removeAttribute("data-motion");
  else html.setAttribute("data-motion", "reduce");
}

function subscribeSwitch(onChange: () => void) {
  listeners.add(onChange);
  const onStorage = (event: StorageEvent) => {
    if (event.key !== MOTION_STORAGE_KEY && event.key !== null) return;
    applyMotion(readSwitch());
    onChange();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onStorage);
  };
}

export function setMotionEnabled(on: boolean) {
  memory = on;
  try {
    if (on) localStorage.removeItem(MOTION_STORAGE_KEY);
    else localStorage.setItem(MOTION_STORAGE_KEY, "off");
    writeFailed = false;
  } catch {
    writeFailed = true;
  }
  applyMotion(on);
  listeners.forEach((listener) => listener());
}

// 설정 화면의 스위치 값. 서버 HTML은 켜짐
export function useMotionSwitch(): boolean {
  return useSyncExternalStore(subscribeSwitch, readSwitch, () => true);
}

// 기기 설정 + 스위치를 합친 값. 효과 안(이벤트 처리)에서 한 번 읽을 때 씀
export function prefersReducedMotion(): boolean {
  try {
    if (window.matchMedia(REDUCE_QUERY).matches) return true;
  } catch {
    // matchMedia가 없는 환경은 스위치만 봄
  }
  return !readSwitch();
}

function subscribeReduced(onChange: () => void) {
  const unsubscribe = subscribeSwitch(onChange);
  let query: MediaQueryList | null = null;
  try {
    query = window.matchMedia(REDUCE_QUERY);
    query.addEventListener("change", onChange);
  } catch {
    query = null;
  }
  return () => {
    unsubscribe();
    query?.removeEventListener("change", onChange);
  };
}

// 화면에서: const reduce = useReducedMotion();  서버 HTML은 줄임(움직이지 않는 그림을 먼저 그림)
export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeReduced,
    prefersReducedMotion,
    () => true,
  );
}
