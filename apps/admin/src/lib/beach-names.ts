import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

// 문의에 붙은 해변 ID → 이름표 (BRD-153). 빌드 때 저장소의 공개 해변 데이터(data/beaches)를 읽음
// 서버 컴포넌트(페이지)에서만 부름. 화면에는 이름·지역·비노출 여부만 내려감(공개 사이트에도 있는 값)
// 운영 API는 해변 ID만 줌. 이름을 API에 넣지 않고 사용자 사이트와 같은 원본을 씀

export interface BeachName {
  readonly name: string;
  readonly region: string;
  // 앱에 비노출(hidden)인 해변: 앱에서는 이 해변 주소가 404(시안 E6 7)
  readonly hidden: boolean;
}

// 명령이 apps/admin에서 실행되므로 저장소 맨 위는 두 칸 위(apps/web/src/lib/beaches.ts와 같음)
const DATA_DIR = path.join(process.cwd(), "../../data/beaches");

interface RawBeach {
  readonly id?: unknown;
  readonly name?: { readonly ko?: unknown };
  readonly region?: {
    readonly sido?: { readonly ko?: unknown };
    readonly sigungu?: { readonly ko?: unknown };
  };
  readonly hidden?: unknown;
}

// 모양이 틀린 파일은 조용히 빼지 않고 빌드를 멈춤(이름이 빠지면 화면이 ID만 보여 줘서 알아채기 어려움)
export function loadBeachNames(dir = DATA_DIR): Record<string, BeachName> {
  const names: Record<string, BeachName> = {};
  for (const file of readdirSync(dir).filter((f) => /^b\d{4}\.json$/.test(f))) {
    const raw = JSON.parse(
      readFileSync(path.join(dir, file), "utf8"),
    ) as RawBeach;
    const sido = raw.region?.sido?.ko;
    const sigungu = raw.region?.sigungu?.ko;
    if (
      typeof raw.id !== "string" ||
      typeof raw.name?.ko !== "string" ||
      typeof sido !== "string" ||
      typeof sigungu !== "string"
    ) {
      throw new Error(`해변 파일 모양이 틀림: ${file}`);
    }
    names[raw.id] = {
      name: raw.name.ko,
      region: `${sido} ${sigungu}`,
      hidden: raw.hidden === true,
    };
  }
  return names;
}
