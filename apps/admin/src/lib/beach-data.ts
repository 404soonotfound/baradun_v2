import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Beach } from "@baradun/contracts";
import {
  METRIC_KEYS,
  type BeachCheck,
  type BeachRecord,
  type BeachSummary,
  type ZoneCheck,
} from "./beaches";

// 해변 관리 화면의 해변 정보 (BRD-150, 화면 ADM-BCH, 결정 기록 D15-4, 아키텍처 18.1)
// 빌드 때 저장소 파일 세 가지를 읽음. 서버 컴포넌트(페이지)에서만 부름(beach-names.ts와 같은 방식)
// - data/beaches/b*.json: 해변 정의·노출(hidden)·좌표·특보구역·관측소·사진
// - data/beach-meta.json: 별칭·운영 기간
// - data/beach-coverage.csv: 검증 결과(특보구역 대응·관측소 배정 근거·실응답 확인)
// 모두 공개 저장소에 있는 값이라 화면에 넣어도 새로 드러나는 것이 없음. 운영 메모·판단 상태는 넣지 않음(운영 API로만)
// 모양이 틀리면 조용히 빼지 않고 빌드를 멈춤. 검증 기록이 없는 해변은 null로 두고 화면이 '기록 없음'으로 보여 줌

// 명령이 apps/admin에서 실행되므로 저장소 맨 위는 두 칸 위(beach-names.ts와 같음)
const DATA = path.join(process.cwd(), "../../data");

// 따옴표 칸(쉼표·줄바꿈·"" 포함)을 읽는 CSV 해석. 첫 줄은 칸 이름
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
      } else {
        cell += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += c;
    }
  }
  if (quoted) throw new Error("CSV 따옴표가 닫히지 않음");
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  const [head, ...body] = rows;
  if (!head) return [];
  return body
    .filter((r) => r.some((v) => v !== ""))
    .map((r, n) => {
      if (r.length !== head.length) {
        throw new Error(`CSV ${n + 2}번째 줄 칸 수가 다름`);
      }
      return Object.fromEntries(head.map((name, i) => [name, r[i]!]));
    });
}

const text = (value: string | undefined): string | null =>
  value === undefined || value.trim() === "" ? null : value;

function zoneCheck(
  row: Record<string, string>,
  prefix: "sea" | "land",
): ZoneCheck {
  return {
    zone: text(row[`${prefix}_zone`]),
    status: text(row[`${prefix}_status`]),
    basis: text(row[`${prefix}_basis`]),
    rule: text(row[`${prefix}_rule_url`]),
    checkedAt: text(row[`${prefix}_checked_at_kst`]),
  };
}

function checkOf(row: Record<string, string>): BeachCheck {
  return {
    stage: text(row.stage),
    coordsSource: text(row.coords_source),
    sea: zoneCheck(row, "sea"),
    land: zoneCheck(row, "land"),
    stationBasis: text(row.station_basis),
    responseCheck: text(row.response_check),
    exclusion: text(row.exclusion),
    reviewReason: text(row.review_reason),
  };
}

interface MetaEntry {
  readonly aliases?: unknown;
  readonly season?: Record<string, unknown>;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function seasonOf(
  entry: MetaEntry | undefined,
  year: string,
): BeachRecord["season"] {
  const raw = entry?.season?.[year] as Record<string, unknown> | null;
  if (raw === undefined || raw === null) return null;
  const { status, openDate, closeDate } = raw;
  const dateOrNull = (d: unknown) =>
    d === null || (typeof d === "string" && DATE.test(d));
  if (
    (status !== "open" && status !== "closed") ||
    !dateOrNull(openDate) ||
    !dateOrNull(closeDate)
  ) {
    throw new Error(`beach-meta.json 운영 기간 모양이 틀림`);
  }
  return {
    year,
    status,
    openDate: openDate as string | null,
    closeDate: closeDate as string | null,
  };
}

// 운영 기간은 빌드 시각의 한국 연도 칸(publisher season.ts와 같이 올해 일정만, 지난해로 추정하지 않음)
const SEASON_YEAR = String(
  new Date(Date.now() + 9 * 60 * 60 * 1000).getUTCFullYear(),
);

// beach-coverage.csv에서 읽는 칸. 칸 이름이 바뀌면 모든 해변이 조용히 '기록 없음'이 되지 않게 빌드를 멈춤
const COVERAGE_COLUMNS = [
  "id",
  "stage",
  "coords_source",
  "sea_zone",
  "sea_status",
  "land_zone",
  "land_status",
  "station_basis",
] as const;

// 목록·상세(해변마다 한 페이지) 빌드가 같은 파일을 해변 수만큼 다시 읽지 않게 폴더별로 한 번만 읽음
const cache = new Map<string, BeachRecord[]>();

export function loadBeaches(dir = DATA, year = SEASON_YEAR): BeachRecord[] {
  // 개발 서버에서는 파일을 고치면 바로 보이게 매번 읽음
  if (process.env.NODE_ENV !== "production") return readBeaches(dir, year);
  const key = `${dir}|${year}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const records = readBeaches(dir, year);
  cache.set(key, records);
  return records;
}

function readBeaches(dir: string, year: string): BeachRecord[] {
  const meta = JSON.parse(
    readFileSync(path.join(dir, "beach-meta.json"), "utf8"),
  ) as { beaches?: Record<string, MetaEntry> };
  if (!meta.beaches) throw new Error("beach-meta.json: beaches 칸이 없음");
  const rows = parseCsv(
    readFileSync(path.join(dir, "beach-coverage.csv"), "utf8"),
  );
  const lacking = rows[0]
    ? COVERAGE_COLUMNS.filter((name) => !(name in rows[0]!))
    : [];
  if (lacking.length > 0) {
    throw new Error(`beach-coverage.csv 칸이 없음: ${lacking.join(", ")}`);
  }
  const coverage = new Map(
    rows.filter((row) => row.id).map((row) => [row.id!, row]),
  );
  const beachDir = path.join(dir, "beaches");
  return readdirSync(beachDir)
    .filter((f) => /^b\d+\.json$/.test(f))
    .sort()
    .map((file) => {
      const beach = JSON.parse(
        readFileSync(path.join(beachDir, file), "utf8"),
      ) as Beach;
      if (
        `${beach.id}.json` !== file ||
        typeof beach.name?.ko !== "string" ||
        typeof beach.region?.sido?.ko !== "string" ||
        typeof beach.region?.sigungu?.ko !== "string" ||
        typeof beach.hidden !== "boolean" ||
        !beach.stations
      ) {
        throw new Error(`해변 파일 모양이 틀림: ${file}`);
      }
      const entry = meta.beaches![beach.id];
      const aliases = entry?.aliases ?? [];
      if (
        !Array.isArray(aliases) ||
        !aliases.every((a) => typeof a === "string")
      ) {
        throw new Error(`beach-meta.json 별칭 모양이 틀림: ${beach.id}`);
      }
      const row = coverage.get(beach.id);
      return {
        id: beach.id,
        slug: beach.slug,
        nameKo: beach.name.ko,
        nameEn: beach.name.en,
        sido: beach.region.sido.ko,
        sigungu: beach.region.sigungu.ko,
        coast: beach.coast,
        lat: beach.coords.lat,
        lng: beach.coords.lng,
        hidden: beach.hidden,
        activities: [...beach.activities],
        aliases: aliases as string[],
        inMeta: entry !== undefined,
        zones: {
          sea: beach.warningZones.sea,
          land: beach.warningZones.land ?? null,
        },
        stations: Object.fromEntries(
          METRIC_KEYS.map((key) => {
            const ref = beach.stations[key];
            return [
              key,
              ref
                ? { id: ref.id, name: ref.name.ko, distanceKm: ref.distanceKm }
                : null,
            ];
          }),
        ) as BeachRecord["stations"],
        photo: beach.photo
          ? {
              url: beach.photo.url,
              source: beach.photo.source,
              license: beach.photo.license,
              title: beach.photo.title ?? null,
            }
          : null,
        season: seasonOf(entry, year),
        check: row ? checkOf(row) : null,
      } satisfies BeachRecord;
    });
}

// 목록에 넘길 값만(검증 근거 글 등 긴 값은 상세 페이지에만 넣음)
export function summaryOf(beach: BeachRecord): BeachSummary {
  return {
    id: beach.id,
    slug: beach.slug,
    nameKo: beach.nameKo,
    sido: beach.sido,
    sigungu: beach.sigungu,
    hidden: beach.hidden,
    aliases: beach.aliases,
    inMeta: beach.inMeta,
    seaZone: beach.zones.sea,
    seaStatus: beach.check?.sea.status ?? null,
    landStatus: beach.check?.land.status ?? null,
    stations: METRIC_KEYS.filter((key) => beach.stations[key] !== null).length,
    waveHeight: beach.stations.waveHeight !== null,
    season: beach.season,
    hasPhoto: beach.photo !== null,
    hasCheck: beach.check !== null,
  };
}
