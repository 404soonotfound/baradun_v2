// 기기에 저장하는 해변 id 목록 — 즐겨찾기·최근 본 해변 (BRD-26)
// 로그인 없음(D1): 브라우저 localStorage에만 저장, 서버로 보내지 않음
// 틀은 lib/activity.ts와 같음: 원본이 React 바깥이라 useSyncExternalStore로 읽음

// [1] 빈 목록 하나를 같이 씀. 매번 새 []를 만들면 React가 바뀐 값으로 보고 계속 다시 그림
export const EMPTY_IDS: readonly string[] = [];

// [2] 목록 맨 앞에 id 넣기. 이미 있으면 앞으로 옮기고, max를 넘으면 뒤(오래된 것)부터 버림
// React는 새 배열이어야 변경을 감지함
export function addToFront(
  list: readonly string[],
  id: string,
  max: number,
): string[] {
  const rest = list.filter((item) => item !== id); // 같은 id 빼기(중복 방지)
  // ...rest = 배열 펼치기, slice(0, max) = 앞에서 max개만
  return [id, ...rest].slice(0, max);
}

// [3] 저장 글자(JSON) → id 목록. 깨졌거나 모양이 다르면 빈 목록(오류로 화면을 멈추지 않음)
export function parseIds(raw: string | null): readonly string[] {
  if (raw === null) return EMPTY_IDS;
  try {
    // unknown = 아직 모르는 값. 검사하기 전에는 칸을 꺼내 쓸 수 없어서 안전함
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return EMPTY_IDS;
    // (item): item is string = 이 검사를 통과한 항목은 string이라고 타입에 알려줌(타입 좁히기)
    return value.filter((item): item is string => typeof item === "string");
  } catch {
    return EMPTY_IDS; // JSON 문법이 깨진 경우
  }
}

// [4] 공장이 돌려주는 저장소의 모양. interface = 객체 모양 정의(type과 거의 같음)
// () => void = 인자 없고 돌려주는 값 없는 함수
export interface DeviceList {
  // 값이 바뀔 때 부를 함수 등록. 돌려주는 함수를 부르면 등록 해제
  subscribe: (onChange: () => void) => () => void;
  getSnapshot: () => readonly string[];
  add: (id: string) => void;
  remove: (id: string) => void;
  // 목록 통째로 바꾸기(되돌리기에서 지우기 전 순서로 복구). max를 넘으면 뒤부터 버림
  replace: (ids: readonly string[]) => void;
  clear: () => void;
}

// [5] 저장 키 하나에 대한 목록 저장소를 만들어 돌려줌
// 안의 변수(memory 등)는 만들 때마다 따로 생김(클로저). 즐겨찾기·최근 본이 서로 섞이지 않음
export function createDeviceList(storageKey: string, max: number): DeviceList {
  // 저장소를 못 쓰는 환경(사생활 보호 모드 등)에서도 이번 방문 동안은 유지
  let memory: readonly string[] = EMPTY_IDS;
  // 마지막으로 읽은 저장 글자와 그 결과. 글자가 같으면 같은 배열을 돌려줌(끝없는 다시 그리기 방지)
  let lastRaw: string | null = null;
  let lastValue: readonly string[] = EMPTY_IDS;
  // 쓰기가 실패한 적 있음(읽기는 되는데 쓰기만 막힌 사생활 보호 모드·용량 초과). 이후로는 memory를 읽음
  let writeFailed = false;
  // Set = 중복 없는 모음. 같은 함수를 두 번 등록해도 하나만 남음
  const listeners = new Set<() => void>();

  function read(): readonly string[] {
    if (writeFailed) return memory; // 저장소의 옛 값이 방금 바꾼 값을 덮지 않게
    let raw: string | null;
    try {
      raw = localStorage.getItem(storageKey);
    } catch {
      return memory; // 저장소를 꺼내기만 해도 오류가 나는 환경
    }
    if (raw !== lastRaw) {
      lastRaw = raw;
      lastValue = parseIds(raw); // 글자가 바뀐 때만 새로 해석
    }
    return lastValue;
  }

  function write(next: readonly string[]) {
    memory = next;
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      // 저장 못 해도 memory로 이번 방문 동안은 유지
      writeFailed = true;
    }
    listeners.forEach((listener) => listener()); // 구독한 화면에 바뀜 알림
  }

  // 객체를 돌려줌. subscribe(onChange) { … } = subscribe: function (onChange) { … }의 줄임
  return {
    subscribe(onChange) {
      listeners.add(onChange);
      // 다른 브라우저 탭에서 바꿔도 반영. key가 null = 저장소 전체를 비움
      const onStorage = (event: StorageEvent) => {
        if (event.key === storageKey || event.key === null) onChange();
      };
      window.addEventListener("storage", onStorage);
      // 등록 해제 함수(Vue의 beforeDestroy에서 removeEventListener 하던 자리)
      return () => {
        listeners.delete(onChange);
        window.removeEventListener("storage", onStorage);
      };
    },
    getSnapshot: read,
    add(id) {
      write(addToFront(read(), id, max));
    },
    remove(id) {
      write(read().filter((item) => item !== id));
    },
    replace(ids) {
      write(ids.slice(0, max));
    },
    clear() {
      write(EMPTY_IDS);
    },
  };
}
