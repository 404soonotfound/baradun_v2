import { useEffect, useSyncExternalStore } from "react";
import { fetchCollection, kstClock, type CollectionView } from "./collection";
import { judgmentLine, partOf, settle } from "./home";

// 왼쪽 메뉴 아래 상태 칸 (GH-450, 시안 4차 V1·V6·E1 aside .w-sys)
// - 판단 출처: 운영 홈 '판단 출처 상태 한 줄'과 같은 기준(judgmentLine). 하나라도 정상이 아니면 문제 수
// - 앱 게시본: 수집 현황 응답의 지금 게시본 시각(KST)
// - 수집 현황을 읽지 못하면 '상태 확인 못 함'. 앞에서 읽은 '정상'을 남겨 두지 않음(실패를 정상으로 보이지 않게)
// - 이 탭 메모리에만 둠. 계정(풀·이메일)에 묶어 다른 계정으로 들어오면 다시 읽음
// - 화면을 옮길 때마다 공통 틀이 새로 그려지므로 1분 안에 읽은 값이면 다시 부르지 않음. 한 화면에 머물면 1분마다 다시 확인

export type ShellStatus =
  | { readonly kind: "loading" }
  | { readonly kind: "unknown" }
  | {
      readonly kind: "ok" | "problem";
      // 정상이 아닌 판단 출처 수(ok면 0)
      readonly problems: number;
      // 'HH:MM:SS'(같은 날) 또는 'M/D HH:MM'. 게시본을 읽지 못하면 null
      readonly published: string | null;
    };

export function shellStatus(view: CollectionView | null): ShellStatus {
  const line = judgmentLine(view);
  if (!view || !line) return { kind: "unknown" };
  const at = view.publish?.publishedAt;
  const published =
    typeof at === "string" && Number.isFinite(Date.parse(at))
      ? kstClock(at, view.generatedAt, true)
      : null;
  return {
    kind: line.problems.length === 0 ? "ok" : "problem",
    problems: line.problems.length,
    published,
  };
}

export const STATUS_FRESH_MS = 60_000;

interface Entry {
  readonly owner: string;
  readonly status: ShellStatus;
  readonly at: number;
}

let entry: Entry | null = null;
let inflight: string | null = null;
const listeners = new Set<() => void>();
const LOADING: ShellStatus = { kind: "loading" };

function publish(next: Entry): void {
  entry = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// 시험에서 탭 메모리를 비움
export function resetShellStatus(): void {
  entry = null;
  inflight = null;
}

export function useShellStatus(
  owner: string | null,
  accessToken: () => Promise<string | null>,
): ShellStatus {
  useEffect(() => {
    if (owner === null) return;
    const load = () => {
      const fresh =
        entry?.owner === owner && Date.now() - entry.at < STATUS_FRESH_MS;
      if (fresh || inflight === owner) return;
      inflight = owner;
      // 시간 제한(D16-E1 30초)·예외는 '확인 못 함'. 멈춘 요청이 '상태 확인 중'에 머물지 않게 함
      void settle(async () =>
        partOf(await fetchCollection(accessToken), (body) => body),
      ).then((part) => {
        // 늦게 온 다른 계정(또는 비운 뒤)의 응답이 지금 값을 덮지 않게 함
        if (inflight !== owner) return;
        inflight = null;
        publish({
          owner,
          status:
            part.state === "ok" ? shellStatus(part.value) : { kind: "unknown" },
          at: Date.now(),
        });
      });
    };
    load();
    // 한 화면에 오래 머물러도 앞에서 읽은 '정상'이 그대로 남지 않게 다시 읽음
    const timer = setInterval(load, STATUS_FRESH_MS);
    return () => clearInterval(timer);
    // accessToken은 세션마다 같은 함수가 아닐 수 있어 계정이 바뀔 때만 다시 읽음
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner]);
  return useSyncExternalStore(
    subscribe,
    () => (owner !== null && entry?.owner === owner ? entry.status : LOADING),
    () => LOADING,
  );
}
