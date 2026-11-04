#!/usr/bin/env bash
# 배포할 커밋과 배포 여부 정하기 (BRD-178, deploy.yml의 site·admin 작업이 함께 씀)
# 사용: deploy-plan.sh <운영 주소> <앱 경로>...
#   앱 경로: 이 앱 빌드가 읽는 파일(ci.yml 바뀐 영역 필터와 같음, workflows.test.ts가 확인)
# 환경: GH_TOKEN·GITHUB_REPOSITORY·GITHUB_OUTPUT·GITHUB_ENV, MANUAL(true/false), HEAD_SHA(수동 실행 커밋)
# 전제: main을 전체 이력으로 체크아웃한 상태(HEAD = main 최신). 끝에 고른 커밋으로 바꿈
#
# 자동 배포
# - 올린 커밋 표시(운영 주소의 deploy-version.txt) 뒤로, 이 앱 파일을 바꾼 커밋 중 main push CI가 성공한
#   가장 새 커밋을 올림. 그 커밋의 CI가 그 트리에서 앱 전체를 검사했으므로, CI가 실패한 앞 커밋의 변경도
#   검사를 거친 뒤에만 나감. 표시 뒤에 그런 커밋이 없으면 건너뜀(옛 커밋이 새 배포를 덮지 않음)
# - 표시를 못 읽으면(첫 배포·주소 오류) 경고를 남기고, 최근 이력에서 앱 파일을 바꾼 성공 커밋(없으면 성공한 가장 새 커밋)을 올림
# - CI 결과는 main push 실행만 봄(PR 실행 결과를 main 검증으로 쓰지 않음). 조회 실패는 실패로 멈춤
# 수동 실행: HEAD_SHA의 main push CI가 성공일 때만, 그 커밋을 늘 올림
set -euo pipefail

url=$1
shift
paths=("$@")

# main push CI 실행 결과(최신 실행이 먼저). 같은 커밋을 다시 돌렸으면 마지막 결과
if ! runs=$(gh api "repos/$GITHUB_REPOSITORY/actions/workflows/ci.yml/runs?branch=main&event=push&per_page=100" \
  --jq '.workflow_runs[] | "\(.head_sha) \(.conclusion // "pending")"'); then
  echo "::error::main CI 실행 결과를 읽지 못했어요. 잠시 뒤 다시 실행해 주세요."
  exit 1
fi
ci_ok() { awk -v s="$1" '$1 == s { print $2; exit }' <<<"$runs"; }
touches() { ! git diff --quiet "$1^" "$1" -- "${paths[@]}"; }

deploy=true
if [ "${MANUAL:-false}" = "true" ]; then
  if [ "$(ci_ok "$HEAD_SHA")" != "success" ]; then
    echo "::error::$HEAD_SHA 의 main CI가 성공이 아니에요. main CI가 통과한 뒤 다시 실행해 주세요."
    exit 1
  fi
  target=$HEAD_SHA
  echo "수동 실행: $target 올림"
else
  deployed=$(curl -fsS --max-time 10 --retry 3 "$url/deploy-version.txt" 2>/dev/null | tr -d '[:space:]' || true)
  target=""
  if printf '%s' "$deployed" | grep -Eq '^[0-9a-f]{40}$' &&
    git cat-file -e "$deployed^{commit}" 2>/dev/null &&
    git merge-base --is-ancestor "$deployed" HEAD; then
    for c in $(git rev-list --first-parent "$deployed..HEAD"); do
      if touches "$c" && [ "$(ci_ok "$c")" = "success" ]; then
        target=$c
        break
      fi
    done
    if [ -z "$target" ]; then
      echo "$deployed 뒤로 이 앱을 바꾸고 main CI가 성공한 커밋이 없음: 건너뜀"
      deploy=false
      target=$deployed
    else
      echo "$deployed 뒤 $target 올림"
    fi
  else
    echo "::warning::올린 커밋 표시를 읽지 못했어요(${deployed:-없음}, $url). 최근 이력에서 고른 커밋을 올려요."
    newest=""
    for c in $(git rev-list --first-parent --max-count=100 HEAD); do
      [ "$(ci_ok "$c")" = "success" ] || continue
      [ -n "$newest" ] || newest=$c
      if touches "$c"; then
        target=$c
        break
      fi
    done
    target=${target:-$newest}
    if [ -z "$target" ]; then
      echo "::error::main 최근 100개 커밋에 main CI가 성공한 커밋이 없어요."
      exit 1
    fi
    echo "$target 올림"
  fi
fi

git checkout --quiet "$target"
echo "SHA=$target" >>"$GITHUB_ENV"
{
  echo "sha=$target"
  echo "deploy=$deploy"
} >>"$GITHUB_OUTPUT"
