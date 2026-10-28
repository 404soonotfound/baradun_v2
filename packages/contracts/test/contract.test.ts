// 예시 검사: valid는 통과, invalid는 거부
// 실행: npm run test -w packages/contracts
import { readdirSync, readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";

// 이 테스트 파일 기준 상대 경로로 JSON 읽기
const read = (path: string) =>
  JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));

// 검사기 준비: 2020-12판 + 날짜·URL 형식
const schema = read("../schemas/contract.schema.json");
const ajv = new Ajv2020({
  allErrors: true, // 첫 오류에서 멈추지 않고 전부 수집
  allowUnionTypes: true, // ["number", "null"] 허용
  strictTypes: false, // if/then 안 type 생략 경고 끔
});
addFormats(ajv);
ajv.addSchema(schema);

// 파일 이름 앞부분 → 검사할 정의 (예: status.xxx.json → StatusFile)
const DEF: Record<string, string> = {
  manifest: "ManifestFile",
  beaches: "BeachesFile",
  status: "StatusFile",
  history: "HistoryFile",
  "nationwide-warnings": "NationwideWarningsFile",
};

// 예시 파일 하나 검사 → { ok, errors }
function validate(dir: "valid" | "invalid", file: string) {
  const def = DEF[file.split(".")[0] ?? ""];
  if (!def) throw new Error(`이름으로 정의를 찾을 수 없음: ${file}`);
  const check = ajv.getSchema(`${schema.$id}#/$defs/${def}`);
  if (!check) throw new Error(`정의 없음: ${def}`);
  const ok = check(read(`../examples/${dir}/${file}`));
  return { ok, errors: check.errors };
}

// 폴더의 .json 파일 목록
const list = (dir: string) =>
  readdirSync(new URL(`../examples/${dir}/`, import.meta.url)).filter((f) =>
    f.endsWith(".json"),
  );

// 정상 예시: 오류 0개
describe("정상 예시는 통과", () => {
  it.each(list("valid"))("%s", (file) => {
    const { ok, errors } = validate("valid", file);
    expect(errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  });
});

describe("개발 상태 예시는 실제 해변 식별자와 맞음", () => {
  interface WarningItem {
    type: string;
    level: string;
    zoneCode: string | null;
    zoneName: string;
  }
  interface CatalogBeach {
    id: string;
    slug: string;
    name: unknown;
    warningZones: unknown;
    stations: Record<string, { id: string } | null> & {
      waveHeight: { id: string } | null;
    };
  }
  const beaches = read("../examples/valid/beaches.json") as {
    beaches: CatalogBeach[];
  };
  const status = read("../examples/valid/status.json") as {
    beaches: Record<
      string,
      {
        category: string;
        reasons: Array<{ code: string }>;
        warning: { items: WarningItem[] };
        observation: {
          metrics: {
            waveHeight: { value: number | null; observedAt: string | null };
          };
        };
      }
    >;
  };

  it("상태가 있는 해변만 카탈로그 원본과 같은 해변·특보구역·측정소를 씀", () => {
    expect(Object.keys(status.beaches)).toEqual(
      beaches.beaches.map((beach) => beach.id),
    );

    // 사진·거리처럼 데이터 재생성 때 바뀌는 값은 비교하지 않음. 판단에 쓰는 연결만 맞춤
    const identity = (beach: CatalogBeach) => ({
      id: beach.id,
      slug: beach.slug,
      name: beach.name,
      warningZones: beach.warningZones,
      stations: Object.fromEntries(
        Object.entries(beach.stations).map(([key, station]) => [
          key,
          station?.id ?? null,
        ]),
      ),
    });
    for (const beach of beaches.beaches) {
      const catalog = read(
        `../../../data/beaches/${beach.id}.json`,
      ) as CatalogBeach;
      expect(identity(beach)).toEqual(identity(catalog));
    }
  });

  it("분류·특보 확인 실패·관측 지연·가까운 관측 없음 사례를 구분함", () => {
    expect(status.beaches.b0001?.category).toBe("clear");
    expect(status.beaches.b0094?.category).toBe("unavailable");
    expect(status.beaches.b0107?.reasons[0]?.code).toBe("warning_unknown");
    expect(status.beaches.b0157).toMatchObject({
      category: "clear",
      observation: {
        metrics: { waveHeight: { value: null, state: "none" } },
      },
    });
    expect(status.beaches.b0272?.reasons[0]?.code).toBe("observation_delayed");
  });

  it("해변에 걸린 특보는 전국 특보 목록에도 있음", () => {
    const nationwide = read("../examples/valid/nationwide-warnings.json") as {
      items: WarningItem[];
    };
    const key = (item: WarningItem) =>
      [item.type, item.level, item.zoneCode, item.zoneName].join("|");
    const listed = new Set(nationwide.items.map(key));

    for (const [id, beach] of Object.entries(status.beaches)) {
      for (const item of beach.warning.items) {
        expect(listed.has(key(item)), `${id} ${key(item)}`).toBe(true);
      }
    }
  });

  it("파고 측정값은 같은 측정소 이력의 같은 시각 값과 맞음", () => {
    const history = read("../examples/valid/history.json") as {
      stations: Record<
        string,
        { points: Array<{ t: string; v: number | null }> }
      >;
    };

    for (const beach of beaches.beaches) {
      const wave = status.beaches[beach.id]?.observation.metrics.waveHeight;
      const stationId = beach.stations.waveHeight?.id;
      if (!stationId || !wave?.observedAt) continue;
      const point = history.stations[stationId]?.points.find(
        (p) => p.t === wave.observedAt,
      );
      expect(point?.v, `${beach.id} ${wave.observedAt}`).toBe(wave.value);
    }
  });
});

// 거부 예시: 반드시 실패
describe("거부 예시는 실패", () => {
  it.each(list("invalid"))("%s", (file) => {
    expect(validate("invalid", file).ok).toBe(false);
  });
});

// 10/20 추가 코드: 중대경보 단계·열대야 주변 특보 (결정 기록 11장)
describe("10/20 추가 코드는 통과", () => {
  it.each([
    ["WarningLevel", "severe_warning"],
    ["NearbyWarningType", "tropical_night"],
  ])("%s: %s", (def, value) => {
    // $defs 안 정의 하나만 꺼내 값 하나 검사
    const check = ajv.getSchema(`${schema.$id}#/$defs/${def}`);
    expect(check?.(value)).toBe(true);
  });
});
