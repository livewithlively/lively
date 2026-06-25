#!/usr/bin/env bash
set -euo pipefail
# ─────────────────────────────────────────────────────────────────────────────
# dev :8080 게이트웨이(MCP + 웹UI) 안전 빌드·재기동.
#   왜 스크립트인가: 손으로 kickstart 만 치면 (1) 빌드 누락으로 옛 코드가 살아남거나,
#   (2) 깨진 빌드로 재기동해 크래시루프에 빠지거나, (3) plist 변경이 반영 안 되는 사고가 난다.
#   이 스크립트는 "빌드 성공해야만 재기동" + "plist 변경 자동 반영" + "헬스체크/로케일 검증"으로
#   게이트웨이가 죽은 채 방치되지 않게 한다.
#
# 사용:  scripts/restart-gateway.sh            # 빌드 + 재기동 + 검증
#        scripts/restart-gateway.sh --no-build  # 빌드 생략(plist/env 만 반영)
#
# launchd: io.lvly.context-ontology (KeepAlive=죽으면 자동 재기동). 이 스크립트는 plist 를
#   bootout→bootstrap 으로 다시 읽어 EnvironmentVariables(LANG 등) 변경까지 반영한다.
# ⚠ 로케일: 게이트웨이는 UTF-8 로케일(LANG/LC_*)이 반드시 있어야 한다. 없으면 tmux 가
#   `list-sessions -F "...\t..."` 출력의 탭·한글을 '_' 로 치환해 세션 파싱이 깨진다(웹터미널 입장 불가).
#   코드(terminal-sessions.tmux())와 plist 양쪽에서 강제하며, 아래 검증이 살아있는 프로세스에서 재확인한다.
# ─────────────────────────────────────────────────────────────────────────────

LABEL="io.lvly.context-ontology"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
APP_DIR="/Users/lively/.openclaw/workspace/productivity/context-ontology"
HEALTH_URL="http://localhost:8080/ui/"
DOMAIN="gui/$(id -u)"
DO_BUILD=1
[[ "${1:-}" == "--no-build" ]] && DO_BUILD=0

cd "$APP_DIR"

# 1) 빌드 — 실패하면 절대 재기동하지 않는다(살아있는 게이트웨이를 깨진 빌드로 갈아엎지 않음 = "죽지도 않게").
if [[ "$DO_BUILD" == 1 ]]; then
  echo "▸ 빌드(tsc 백엔드+프론트)…"
  if ! npm run build; then
    echo "✗ 빌드 실패 — 재기동을 중단합니다. 기존 게이트웨이는 그대로 살아있습니다." >&2
    exit 1
  fi
  echo "✓ 빌드 성공"
fi

# 2) plist 재적재(bootout→bootstrap) — EnvironmentVariables(LANG 등) 변경까지 반영. KeepAlive 가
#    이후 살아있게 유지한다. 이미 로드돼 있으면 bootout 으로 먼저 내린다(없으면 무시).
echo "▸ 게이트웨이 재적재(plist 반영)…"
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
# bootout 직후 bootstrap 이 'already loaded/IO error' 로 레이스 날 수 있어 짧게 재시도. 끝내 안 되면 kickstart 폴백.
ok=0
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if launchctl bootstrap "$DOMAIN" "$PLIST" 2>/dev/null; then ok=1; break; fi
  sleep 1
done
if [[ "$ok" != 1 ]]; then
  echo "  bootstrap 레이스 — kickstart 로 폴백"
  launchctl kickstart -k "$DOMAIN/$LABEL" 2>/dev/null || true
fi

# 3) 헬스체크 — :8080 이 200 줄 때까지 대기(curl 자체 재시도, 최대 ~40s). 못 뜨면 명확히 실패 보고.
echo "▸ 헬스체크(${HEALTH_URL})…"
if curl -fsS --retry 40 --retry-delay 1 --retry-all-errors --retry-connrefused -o /dev/null "$HEALTH_URL"; then
  PID="$(lsof -nP -iTCP:8080 -sTCP:LISTEN -t 2>/dev/null | head -1)"
  echo "✓ 게이트웨이 기동 완료 (PID ${PID:-?})"
else
  echo "✗ 게이트웨이가 ${HEALTH_URL} 에 응답하지 않습니다. launchd KeepAlive 가 재시도 중일 수 있습니다." >&2
  echo "  로그 확인: tail -n 50 ${APP_DIR}/logs/launchd-gateway.err" >&2
  exit 1
fi

# 4) 로케일 검증 — 살아있는 프로세스 env 에 UTF-8 LANG 이 있는지(이 버그의 재발 방지 가드).
PID="$(lsof -nP -iTCP:8080 -sTCP:LISTEN -t 2>/dev/null | head -1)"
if [[ -n "${PID:-}" ]] && ps eww -p "$PID" 2>/dev/null | tr ' ' '\n' | grep -qiE '^(LANG|LC_ALL|LC_CTYPE)=.*utf-?8'; then
  echo "✓ 로케일 OK — tmux 세션 파싱 안전(탭 구분자 보존)"
else
  echo "⚠ 경고: 프로세스 env 에서 UTF-8 로케일을 확인하지 못했습니다. plist 의 LANG/LC_* 를 점검하세요." >&2
fi
