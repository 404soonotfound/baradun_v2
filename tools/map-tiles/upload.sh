#!/usr/bin/env bash
# build.sh 결과를 사이트 버킷 map/<판>/에 올림 (결정 기록 D19-1 · #392)
# 사용: tools/map-tiles/upload.sh <build.sh 출력 폴더> <버킷 이름>
# - 판 이름은 실행마다 새것(만든 시각)이라, 같은 판 폴더가 조금이라도 있으면 멈춤(1년 캐시와 충돌하지 않게 덮어쓰지 않음)
# - 다 올린 판에는 마지막에 READY.txt를 둠. 올리다 실패해 READY.txt가 없는 판은 쓰지 않고 다시 실행(새 판)
# - 판마다 폴더가 따로라 1년 캐시(immutable). 웹은 판 이름을 코드에 적어 고름
set -euo pipefail

SRC=${1:?"build.sh 출력 폴더를 주세요"}
BUCKET=${2:?"버킷 이름을 주세요"}
VERSION=$(cat "$SRC/VERSION")
if ! [[ $VERSION =~ ^[0-9]{8}-[0-9]{4}$ ]]; then
  echo "::error::판 이름이 YYYYMMDD-HHMM이 아니에요: $VERSION" >&2
  exit 1
fi

PREFIX="map/$VERSION"
existing=$(aws s3api list-objects-v2 --bucket "$BUCKET" --prefix "$PREFIX/" --max-keys 1 --query 'KeyCount' --output text)
if [ "$existing" != "0" ]; then
  echo "::error::s3://$BUCKET/$PREFIX/가 이미 있어요. 워크플로를 다시 실행해 새 판으로 만들어 주세요" >&2
  exit 1
fi

CACHE="public, max-age=31536000, immutable"
# 지도 파일은 범위 요청으로 읽으므로 CloudFront가 압축하지 않는 형식으로 둠(타일은 이미 gzip)
aws s3 cp "$SRC/$VERSION/korea.pmtiles" "s3://$BUCKET/$PREFIX/korea.pmtiles" \
  --content-type "application/octet-stream" --cache-control "$CACHE" --only-show-errors
aws s3 cp "$SRC/$VERSION/fonts" "s3://$BUCKET/$PREFIX/fonts" --recursive \
  --content-type "application/x-protobuf" --cache-control "$CACHE" --only-show-errors
aws s3 cp "$SRC/$VERSION/sprites" "s3://$BUCKET/$PREFIX/sprites" --recursive \
  --cache-control "$CACHE" --only-show-errors

# 다 올렸다는 표시(마지막). 확장자가 있어야 사이트 주소(https://<사이트>/map/<판>/READY.txt)로 열림
printf '%s\n' "$VERSION" | aws s3 cp - "s3://$BUCKET/$PREFIX/READY.txt" \
  --content-type "text/plain; charset=utf-8" --cache-control "$CACHE" --only-show-errors

echo "올림: s3://$BUCKET/$PREFIX/ (웹 지도 판 이름: $VERSION)"
