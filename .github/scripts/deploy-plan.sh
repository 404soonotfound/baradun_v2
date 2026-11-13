#!/usr/bin/env bash
# 배포할 커밋과 배포 여부 정하기 (BRD-178, deploy.yml의 site·admin 작업이 함께 씀)
# 사용: deploy-plan.sh <운영 주소> <앱 경로>...
#   앱 경로: 이 앱 빌드가 읽는 파일(ci.yml 바뀐 영역 필터와 같음, workflows.test.ts가 확인)
# 환경: GH_TOKEN·GITHUB_REPOSITORY·GITHUB_OUTPUT·GITHUB_ENV, MANUAL(true/false), HEAD_SHA(수동 실행 커밋),
#   CI_JOB(이 앱을 빌드하는 ci.yml 작업 이름. 바뀐 영역 검사로 건너뛰면 그 실행은 이 앱을 검사하지 않은 것)
# 전제: main을 전체 이력으로 체크아웃한 상태(HEAD = main 최신). 끝에 고른 커밋으로 바꿈
#
# 정기 배포(하루 한 번, GH-424. 예전 이름: 자동 배포)
# - 올린 커밋 표시(운영 주소의 deploy-version.txt) 뒤로, main push CI가 성공하고 그 실행에서 이 앱 빌드 작업까지
#   성공한 가장 새 커밋을 올림. 검사는 push 단위라(여러 커밋 머지는 맨 위 커밋만 실행) 커밋별 변경이 아닌 실행 결과로 봄.
#   CI가 실패한 커밋의 변경은 그 앱을 다시 검사한 실행을 거친 뒤에만 나감. 그런 커밋이 없거나 표시와 앱 파일이
#   같으면 건너뜀(옛 커밋이 새 배포를 덮지 않음)
# - 표시를 못 읽으면(첫 배포·주소 오류) 경고를 남기고, 최근 이력에서 이 앱을 검사한 성공 커밋(없으면 성공한 가장 새 커밋)을 올림
# - CI 결과는 main push 실행만 봄(PR 실행 결과를 main 검증으로 쓰지 않음). 조회 실패는 실패로 멈춤
# 수동 실행: HEAD_SHA의 main push CI가 성공일 때만, 그 커밋을 늘 올림
set -euo pipefail

url=$1
shift
paths=("$@")
: "${CI_JOB:?CI_JOB(이 앱 빌드 작업 이름)이 없음}"

# 수동 실행은 대상 SHA만 조회하고 정기 실행은 최근 main push 이력을 조회함.
# 같은 커밋을 다시 돌렸으면 최신 결과를 사용함.
ci_query="repos/$GITHUB_REPOSITORY/actions/workflows/ci.yml/runs?branch=main&event=push"
if [ "${MANUAL:-false}" = "true" ]; then
  ci_query="$ci_query&head_sha=${HEAD_SHA:?HEAD_SHA(수동 실행 커밋)가 없음}&per_page=1"
else
  ci_query="$ci_query&per_page=100"
fi
if ! runs=$(gh api "$ci_query" \
  --jq '.workflow_runs[] | "\(.head_sha) \(.conclusion // "pending") \(.id)"'); then
  echo "::error::main CI 실행 결과를 읽지 못했어요. 잠시 뒤 다시 실행해 주세요."
  exit 1
fi
ci_ok() { awk -v s="$1" '$1 == s { print $2; exit }' <<<"$runs"; }
# 그 커밋의 CI가 성공했고, 그 실행에서 이 앱 빌드 작업도 성공했는지(건너뜀은 검사 안 함)
checked() {
  [ "$(ci_ok "$1")" = "success" ] || return 1
  local id job
  id=$(awk -v s="$1" '$1 == s { print $3; exit }' <<<"$runs")
  if ! job=$(gh api "repos/$GITHUB_REPOSITORY/actions/runs/$id/jobs?per_page=100" \
    --jq ".jobs[] | select(.name == \"$CI_JOB\") | .conclusion"); then
    echo "::error::main CI 실행 $id 의 작업 결과를 읽지 못했어요. 잠시 뒤 다시 실행해 주세요."
    exit 1
  fi
  [ "$job" = "success" ]
}

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
      if checked "$c"; then
        target=$c
        break
      fi
    done
    if [ -z "$target" ]; then
      echo "$deployed 뒤로 main CI가 이 앱($CI_JOB)까지 검사해 성공한 커밋이 없음: 건너뜀"
      # 앱 파일은 바뀌었는데 검사한 실행이 없으면(CI 실패 뒤 다른 영역만 고침 등) 다음 앱 변경까지 남으므로 알림
      if ! git diff --quiet "$deployed" HEAD -- "${paths[@]}"; then
        echo "::warning::$deployed 뒤 앱 파일 변경이 아직 main CI($CI_JOB) 검사를 거치지 않았어요. 검사가 진행 중이면 끝난 뒤 다음 정기 배포 때 올라가고, 실패했으면 그 CI를 다시 실행한 뒤 npm run deploy:prod로 올려 주세요."
      fi
      deploy=false
      target=$deployed
    elif git diff --quiet "$deployed" "$target" -- "${paths[@]}"; then
      echo "$deployed 와 $target 의 앱 파일이 같음: 건너뜀"
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
      if checked "$c"; then
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
