#!/usr/bin/env bash
# Playwright 브라우저·OS 의존성(글꼴) 설치를 빌드와 함께 돌림 (ci.yml의 e2e-build·admin-build가 씀)
# 사용: playwright-setup.sh start <playwright 인자>...   예: start install-deps chromium
#       playwright-setup.sh wait
#   start: 설치를 뒤에서 시작하고 바로 돌아옴. 로그와 종료 코드는 RUNNER_TEMP 아래에 남김
#   wait:  설치가 끝나기를 기다렸다가 로그를 보여 줌. 설치가 성공했으면 0, 아니면 1로 끝남(설치의 종료 코드는 오류 문구에 적음)
# 설치를 시작한 기록이 없거나, 종료 코드를 남기지 않고 끝났거나, 제한 시간을 넘기면 실패함(확인 없이 E2E로 넘어가지 않음)
# 환경: RUNNER_TEMP, PLAYWRIGHT_SETUP_TIMEOUT(wait가 기다리는 시간, 초, 기본 600. 설치를 시작한 때가 아니라 wait를 부른 때부터 잼)
set -euo pipefail

dir="${RUNNER_TEMP:?RUNNER_TEMP가 없음}/playwright-setup"

fail() {
  echo "::error::$1"
  exit 1
}

show_log() {
  if [ -f "$dir/log" ]; then
    cat "$dir/log"
  fi
}

case "${1:-}" in
  start)
    shift
    [ "$#" -gt 0 ] || fail "playwright 인자가 필요해요"
    mkdir -p "$dir"
    rm -f "$dir/exit" "$dir/exit.tmp" "$dir/log" "$dir/pid"
    # 종료 코드는 임시 파일에 쓴 뒤 이름을 바꿈(쓰는 도중의 빈 파일을 읽지 않게)
    # 표준 출력·오류를 로그로 돌려 이 단계가 설치를 기다리지 않게 함
    # shellcheck disable=SC2016 # 안쪽 셸이 펼치는 변수라 작은따옴표로 둠
    nohup bash -c '
      dir=$1
      shift
      code=0
      npx --no-install playwright "$@" > "$dir/log" 2>&1 || code=$?
      echo "$code" > "$dir/exit.tmp"
      mv "$dir/exit.tmp" "$dir/exit"
    ' playwright-setup "$dir" "$@" > /dev/null 2>&1 &
    echo "$!" > "$dir/pid"
    echo "Playwright 설치를 뒤에서 시작함: $*"
    ;;
  wait)
    [ -f "$dir/pid" ] || fail "Playwright 설치를 시작한 기록이 없어요"
    pid=$(cat "$dir/pid")
    timeout="${PLAYWRIGHT_SETUP_TIMEOUT:-600}"
    # 숫자가 아니면 아래 비교가 늘 거짓이 되어 제한 시간 없이 기다리게 됨
    [[ "$timeout" =~ ^[0-9]+$ ]] || fail "PLAYWRIGHT_SETUP_TIMEOUT은 초 단위 숫자여야 해요"
    until [ -f "$dir/exit" ]; do
      if ! kill -0 "$pid" 2> /dev/null; then
        # 끝난 직후 종료 코드 파일이 생기는 틈을 한 번 더 확인함
        sleep 1
        [ -f "$dir/exit" ] && break
        show_log
        fail "Playwright 설치가 종료 코드를 남기지 않고 끝났어요"
      fi
      if [ "$SECONDS" -ge "$timeout" ]; then
        show_log
        fail "Playwright 설치가 ${timeout}초 안에 끝나지 않았어요"
      fi
      sleep 1
    done
    show_log
    code=$(cat "$dir/exit")
    [[ "$code" =~ ^[0-9]+$ ]] || fail "Playwright 설치 종료 코드를 읽지 못했어요"
    [ "$code" -eq 0 ] || fail "Playwright 설치가 실패했어요(종료 코드 $code)"
    echo "Playwright 설치 확인함"
    ;;
  *)
    fail "사용: playwright-setup.sh start <playwright 인자>... | wait"
    ;;
esac
