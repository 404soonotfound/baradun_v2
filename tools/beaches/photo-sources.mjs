// BRD-58 대표 사진의 TourAPI 관광지 ID 대장(data/photo-sources.json) 만들기
// data/beaches의 photo.url이 TourAPI 어느 관광지의 사진인지 찾아 contentId를 남김
// → collect-catalog가 매일 그 관광지 사진의 공공누리 유형을 다시 확인할 수 있게 함(2026-10-23 사용자 결정)
// 찾는 방법: 저작물명·해변 이름으로 searchKeyword2 → 대표 이미지(firstimage)가 같거나, detailImage2 목록에 같은 주소가 있는 관광지
// 둘 이상이 맞거나 하나도 없으면 대장에 넣지 않고 출력함(추측하지 않음)
// 실행: DATA_GO_KR_SERVICE_KEY=... node tools/beaches/photo-sources.mjs [--dry]
// 키는 환경 변수로만 읽고 출력·저장하지 않음
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, "../../data");
const OUT = join(DATA, "photo-sources.json");
const BASE = "https://apis.data.go.kr/B551011/KorService2";

// http·https 차이는 같은 사진으로 봄(PR #33에서 https로 바꿔 넣음)
export const sameImage = (a, b) =>
  typeof a === "string" &&
  typeof b === "string" &&
  a !== "" &&
  a.replace(/^https?:\/\//, "") === b.replace(/^https?:\/\//, "");

const list = (json) => {
  const item = json?.response?.body?.items?.item;
  return Array.isArray(item) ? item : item ? [item] : [];
};

async function call(key, op, params) {
  const url = `${BASE}/${op}?${new URLSearchParams({ serviceKey: key, MobileOS: "ETC", MobileApp: "baradun", _type: "json", ...params })}`;
  const res = await fetch(url);
  const json = await res.json().catch(() => null);
  const code = json?.response?.header?.resultCode;
  if (!res.ok || code !== "0000")
    throw new Error(`${op} 실패: http ${res.status} code ${code ?? "?"}`);
  return list(json);
}

// 해변 하나 → 맞는 관광지 목록(중복 없이)
async function findSources(key, beach) {
  const { url, title } = beach.photo;
  const keywords = [...new Set([title, beach.name.ko].filter(Boolean))];
  const found = new Map();
  for (const keyword of keywords) {
    const items = await call(key, "searchKeyword2", {
      keyword,
      numOfRows: "30",
      pageNo: "1",
    });
    for (const item of items) {
      const contentId = String(item.contentid);
      if (found.has(contentId)) continue;
      if (sameImage(item.firstimage, url)) {
        found.set(contentId, { contentId, title: item.title, image: "first" });
        continue;
      }
      // 대표 이미지가 다르면 상세 이미지 목록에서 찾음. 관광지(12)만 봄(가게·화장실 제외)
      if (String(item.contenttypeid) !== "12") continue;
      const images = await call(key, "detailImage2", {
        contentId,
        imageYN: "Y",
        numOfRows: "100", // collect-catalog와 같은 범위(services/src/collectors/catalog.ts)
        pageNo: "1",
      });
      if (images.some((img) => sameImage(img.originimgurl, url))) {
        found.set(contentId, { contentId, title: item.title, image: "detail" });
      }
    }
    if (found.size > 0) break;
  }
  return [...found.values()];
}

async function main() {
  const key = process.env.DATA_GO_KR_SERVICE_KEY;
  if (!key) throw new Error("DATA_GO_KR_SERVICE_KEY 없음");
  const dry = process.argv.includes("--dry");
  const beaches = readdirSync(join(DATA, "beaches"))
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(DATA, "beaches", f), "utf8")))
    .filter((b) => b.photo !== null)
    .sort((a, b) => a.id.localeCompare(b.id));

  const sources = {};
  const problems = [];
  for (const beach of beaches) {
    try {
      const found = await findSources(key, beach);
      if (found.length === 1)
        sources[beach.id] = { ...found[0], url: beach.photo.url };
      else
        problems.push({
          id: beach.id,
          name: beach.name.ko,
          found: found.map((f) => `${f.contentId}:${f.title}`),
        });
    } catch (error) {
      // 원문 메시지에 주소(키)가 담길 수 있어 키(원문·인코딩 모양)를 가림
      problems.push({
        id: beach.id,
        name: beach.name.ko,
        error:
          error instanceof Error
            ? error.message
                .split(key)
                .join("***")
                .split(encodeURIComponent(key))
                .join("***")
            : "unknown",
      });
    }
  }

  const out = {
    _meta: {
      note: "대표 사진(data/beaches photo)의 TourAPI 관광지 ID·사진 주소 대장(공개 계약 밖, BRD-58). collect-catalog가 매일 이 관광지의 사진 공공누리 유형을 다시 확인함",
      source:
        "한국관광공사 국문 관광정보 서비스_GW(KorService2) searchKeyword2·detailImage2",
      image:
        "first = 관광지 대표 이미지(firstimage), detail = 상세 이미지 목록(detailImage2)",
    },
    beaches: sources,
  };
  console.log(
    `사진 ${beaches.length}곳 중 ${Object.keys(sources).length}곳 연결, 확인 필요 ${problems.length}곳`,
  );
  for (const p of problems) console.log("  확인 필요", JSON.stringify(p));
  if (!dry) writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
