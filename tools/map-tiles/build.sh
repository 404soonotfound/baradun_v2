#!/usr/bin/env bash
# 한국 지도 파일(PMTiles)·글꼴·sprite 만들기 (결정 기록 D19-1 · #392)
# 사용: tools/map-tiles/build.sh <출력 폴더>
#   → <출력>/<판>/korea.pmtiles, <출력>/<판>/fonts/<글꼴>/<범위>.pbf, <출력>/<판>/sprites/ofm*.{json,png}
#   → <출력>/VERSION(판 이름 = 만든 시각 UTC, YYYYMMDD-HHMM. 실행마다 새 판이라 올린 파일을 덮어쓰지 않음)
# 도구·글꼴·sprite는 버전과 체크섬(또는 커밋 SHA)으로 고정함. OSM 데이터는 그날 최신(Geofabrik .md5로 확인)
# Planetiler --download가 받는 보조 자료(바다 polygon·Natural Earth·호수 이름선)는 Planetiler 기본 주소의 최신본이라 고정하지 않음
# 지도 스키마는 OpenFreeMap과 같은 OpenMapTiles(Planetiler 기본 프로필) → 스타일 JSON을 그대로 씀
set -euo pipefail

OUT=${1:?"출력 폴더를 주세요"}
JAVA=${JAVA:-java}

PLANETILER_VERSION=0.10.2
PLANETILER_SHA256=f310bd0413e2e4512b27f4046d418664e8e1d3bf31603c2a70e23de06c167e4d
PMTILES_VERSION=1.31.2 # protomaps/go-pmtiles, Linux x86_64(검사에만 씀)
PMTILES_SHA256=3ed7dbf4ec2e6dfe5e25b6f70d1ffc932729f93c86db353bf514dd71010a312f
OSM_URL=https://download.geofabrik.de/asia/south-korea-latest.osm.pbf
# 글꼴: OpenFreeMap이 쓰는 원본(maplibre/demotiles의 Noto Sans)
FONTS_REPO=https://github.com/maplibre/demotiles.git
FONTS_SHA=601ae60796ceceda2cbd2ed3d2ea92d17a84be4b
FONTS=("Noto Sans Regular" "Noto Sans Bold" "Noto Sans Italic") # 스타일 JSON의 text-font
# sprite: OpenFreeMap 스타일 저장소의 ofm_f384(지금 스타일이 쓰는 판)
SPRITE_BASE=https://raw.githubusercontent.com/hyperknot/openfreemap-styles/006ea5796803ba2df4330888836cb0a8f17473b4/sprites/sprites/ofm_f384
SPRITES=(
  "ofm.json 73e75e58d8c7bb62cc25d9d150660500552f4d04f6eac5efa4e236076773c356"
  "ofm.png 8996a519d218dc5f98015267709dae272a77bb74ef0ecc5a0992dcf276c1be4c"
  "ofm@2x.json 82a4aaeed2c5ce6e98553915754dbe394ee66fd9a2aacc4318d25cdd74e8730b"
  "ofm@2x.png 3793faf7dc47960636e4b6b1039978fa6925e6c90a7cb49ef23b37e153635c9b"
)

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

fetch() { curl -sSfL --retry 3 -o "$2" "$1"; }
check() { echo "$2  $1" | sha256sum -c --quiet -; }

echo "== 도구 받기"
fetch "https://github.com/onthegomap/planetiler/releases/download/v${PLANETILER_VERSION}/planetiler.jar" "$WORK/planetiler.jar"
check "$WORK/planetiler.jar" "$PLANETILER_SHA256"
fetch "https://github.com/protomaps/go-pmtiles/releases/download/v${PMTILES_VERSION}/go-pmtiles_${PMTILES_VERSION}_Linux_x86_64.tar.gz" "$WORK/pmtiles.tar.gz"
check "$WORK/pmtiles.tar.gz" "$PMTILES_SHA256"
tar -xzf "$WORK/pmtiles.tar.gz" -C "$WORK" pmtiles

echo "== 한국 OSM 데이터 받기"
# Geofabrik이 하루 한 번 새로 게시하는 순간에 받으면 데이터와 .md5가 서로 다른 판일 수 있음 → 다시 받음
for attempt in 1 2 3; do
  fetch "$OSM_URL.md5" "$WORK/south-korea-latest.osm.pbf.md5"
  fetch "$OSM_URL" "$WORK/south-korea-latest.osm.pbf"
  if (cd "$WORK" && md5sum -c --quiet south-korea-latest.osm.pbf.md5); then
    break
  fi
  if [ "$attempt" -eq 3 ]; then
    echo "::error::한국 OSM 데이터 체크섬이 3번 모두 맞지 않아요" >&2
    exit 1
  fi
  sleep 60
done

VERSION=$(date -u +%Y%m%d-%H%M)
DEST="$OUT/$VERSION"
if [ -e "$DEST" ]; then
  echo "::error::$DEST가 이미 있어요" >&2
  exit 1
fi
mkdir -p "$DEST/fonts" "$DEST/sprites"

echo "== 지도 파일 만들기 (판 $VERSION)"
"$JAVA" -Xmx6g -jar "$WORK/planetiler.jar" \
  --osm-path="$WORK/south-korea-latest.osm.pbf" \
  --download --download-dir="$WORK/sources" --tmpdir="$WORK/tmp" \
  --output="$DEST/korea.pmtiles"
"$WORK/pmtiles" verify "$DEST/korea.pmtiles"
"$WORK/pmtiles" show "$DEST/korea.pmtiles"

echo "== 글꼴 받기"
git -C "$WORK" init -q fonts
git -C "$WORK/fonts" remote add origin "$FONTS_REPO"
git -C "$WORK/fonts" sparse-checkout set --no-cone "${FONTS[@]/#/font/}"
git -C "$WORK/fonts" fetch -q --depth 1 --filter=blob:none origin "$FONTS_SHA"
git -C "$WORK/fonts" checkout -q FETCH_HEAD
for font in "${FONTS[@]}"; do
  count=$(find "$WORK/fonts/font/$font" -name '*.pbf' | wc -l)
  if [ "$count" -ne 256 ]; then
    echo "::error::$font 글꼴 범위가 256개가 아니에요($count)" >&2
    exit 1
  fi
  cp -R "$WORK/fonts/font/$font" "$DEST/fonts/"
done

echo "== sprite 받기"
for entry in "${SPRITES[@]}"; do
  read -r name sha <<<"$entry"
  fetch "$SPRITE_BASE/$name" "$DEST/sprites/$name"
  check "$DEST/sprites/$name" "$sha"
done

printf '%s\n' "$VERSION" >"$OUT/VERSION"
du -sh "$DEST"/* "$DEST"
echo "판: $VERSION"
