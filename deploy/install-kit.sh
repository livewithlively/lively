#!/usr/bin/env bash
set -euo pipefail
# ─────────────────────────────────────────────────────────────────────────────
# 중앙박스 키트 설치 — 이 호스트의 claude(/codex)에 lively 하네스를 깐다.
#   왜: 게이트웨이의 중앙박스(웹터미널) 세션은 이 호스트에서 claude 를 돌린다. 그 세션이 lively MCP 로
#       조직 맥락을 CRUD 하려면, 호스트의 claude 에 lively 가 등록돼 있어야 한다(멤버 로컬 설치와 동일 필요).
#   무엇: 멤버 로컬 설치(/install 번들)와 **동일한 end-state**를, 게이트웨이=localhost 로, OS-무관 경로로.
#       (키트의 install-via-curl.sh 는 setup-mac.sh 에만 위임 = Mac 전용 → 중앙박스/Linux 는 이 스크립트로.)
#   결과: ~/.lively/{token,gateway-url,context.md,hooks/…} + ~/.claude/settings.json(훅 비파괴 머지)
#         + `claude mcp add lively`(user scope). → 호스트에서 켜는 모든 claude 세션이 lively-aware.
#         + ~/.lively/{lib,bin}/lively — **lively CLI 도 함께 깔린다**(#864). user-install.mjs 가 번들의
#           cli/lively.mjs 를 설치하므로 박스도 공짜로 얻는다 → 박스에서 `lively status`/`lively doctor` 사용 가능.
#
# 사용:  bash deploy/install-kit.sh
#   env(선택): LIVELY_GATEWAY(기본 http://localhost:$PORT) · LIVELY_TOKEN(기본 .env AUTH_TOKENS_JSON 첫 키)
#             KIT_HARNESS(기본 claude; codex 도 깔려면 'claude,codex')
#
# ⚠ 현재는 호스트 단일 claude 인증/토큰을 공유한다(세션 = 'agent' 신원). 프로필별 다른 클코 계정은
#   프로젝트 #269 태스크 #271 에서. (knowledge: context-ontology-셀프호스트-배포-option2-ec2-파일럿)
# ─────────────────────────────────────────────────────────────────────────────
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$DIR/lib/common.sh"

require_cmd curl; require_cmd node
command -v claude >/dev/null 2>&1 || die "claude CLI 없음 — 중앙박스 세션용. 먼저 설치(npm i -g @anthropic-ai/claude-code)."

PORT="${PORT:-8080}"
GW="${LIVELY_GATEWAY:-http://localhost:${PORT}}"; GW="${GW%/}"
TOKEN="${LIVELY_TOKEN:-}"
if [ -z "$TOKEN" ]; then
  [ -f "$APP_DIR/.env" ] || die ".env 없음 — LIVELY_TOKEN 을 직접 주거나 먼저 install.sh 실행."
  TOKEN="$(node --env-file="$APP_DIR/.env" -e 'try{console.log(Object.keys(JSON.parse(process.env.AUTH_TOKENS_JSON))[0])}catch{process.exit(1)}')" \
    || die ".env AUTH_TOKENS_JSON 에서 토큰을 못 읽음."
fi
HARNESS="${KIT_HARNESS:-claude}"

log "중앙박스 키트 설치 — gateway=$GW · harness=$HARNESS"

# 1) ~/.lively/{token,gateway-url} — 세션 훅의 라이브 컨텍스트 fetch + 추후 update 가 읽는다.
#  ⚠ 프로필 모드(KIT_PROFILE_ONLY=1 — provisionProfile 이 '멤버 토큰'으로 호출): 공유 ~/.lively/token 은
#    전 세션의 훅 fetch 가 공유하는 파일이라 멤버 토큰으로 덮으면 안 된다. HOME 공유분은 호스트 설치가 이미
#    세팅했으니 건너뛰고, 멤버 토큰은 프로필 .claude.json(4단계 register-clients)에만 굽는다.
#  ⛔ **이 스크립트는 `lively` CLI 를 부르면 안 된다**(아래 3·4 처럼 엔진을 직접 실행할 것). 프로필 모드는
#    '파일(호스트 토큰) ≠ env(멤버 토큰)' 를 **의도적으로** 만드는 유일한 경로인데, CLI 의 token() 은
#    #916 이후 **파일 우선**이다 → CLI 를 태우면 호스트 토큰이 멤버 프로필 .claude.json 에 구워진다(권한 상승).
if [ "${KIT_PROFILE_ONLY:-0}" = 1 ]; then
  log "프로필 모드(KIT_PROFILE_ONLY) — 공유 ~/.lively/token 보존(멤버 토큰은 프로필 .claude.json 에만)"
else
  mkdir -p "$HOME/.lively"
  umask 077; printf '%s' "$TOKEN" > "$HOME/.lively/token"; umask 022
  printf '%s' "$GW" > "$HOME/.lively/gateway-url"
  ok "~/.lively/{token,gateway-url} 기록"
fi

# 2) /install 번들(게이트웨이가 DB→materialize 로 동적 생성) 다운로드·전개.
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
curl -fsSL -H "Authorization: Bearer $TOKEN" "$GW/install" -o "$TMP/bundle.tgz" \
  || die "/install 다운로드 실패 — 게이트웨이/토큰 확인."
tar -xzf "$TMP/bundle.tgz" -C "$TMP"
[ -f "$TMP/setup/user-install.mjs" ] || die "번들 손상(setup/user-install.mjs 없음)."
ok "발행 번들 다운로드·전개 ($(du -h "$TMP/bundle.tgz" | cut -f1))"

# 3) user-level 설치(컨텍스트·훅·settings 비파괴 머지) — OS-무관(node). setup-mac.sh 대신 직접 호출.
node "$TMP/setup/user-install.mjs" --harness "$HARNESS"
ok "user-level 설치(~/.lively + ~/.claude/settings.json 훅 머지)"

# 4) MCP 등록(lively + org_mcp_server) — 번들의 register-clients.sh(OS-무관, claude CLI).
LIVELY_TOKEN="$TOKEN" STORE_URL="${GW}/mcp" bash "$TMP/setup/register-clients.sh"
ok "MCP 등록 완료"

log "검증: claude mcp list | grep -i lively   ·   ls ~/.lively"
ok "중앙박스 키트 설치 완료 — 이 호스트의 claude 세션이 lively 맥락을 CRUD 할 수 있습니다."
