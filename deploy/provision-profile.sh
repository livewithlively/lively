#!/usr/bin/env bash
set -euo pipefail
# ─────────────────────────────────────────────────────────────────────────────
# 프로필 프로비저닝 — 멀티프로필(#346). 한 멤버의 개인 Claude 계정용 프로필을 이 중앙박스에 준비한다.
#
#   무엇: 멤버별 격리된 CLAUDE_CONFIG_DIR 에 lively 키트(훅 settings + MCP)를 깐다. 그 뒤 그 멤버가
#         (사람 1회) 자기 Claude 계정으로 로그인하면, 그 멤버가 띄우는 중앙박스 세션은 seam(terminal-sessions.ts)이
#         자동으로 이 프로필의 CLAUDE_CONFIG_DIR 을 주입해 **그 멤버 계정으로** claude 를 돌린다(M1).
#   공유 vs 프로필별: ~/.lively(조직 컨텍스트·훅·토큰)는 **공유**(HOME 기준). 프로필별로 다른 건
#         settings.json(훅·권한)·.claude.json(MCP)·.credentials.json(로그인)뿐 — 전부 CLAUDE_CONFIG_DIR 안.
#   ⚠ 전제: 게이트웨이가 CLAUDE_CONFIG_DIR-aware user-install.mjs 를 서빙해야 한다(이 브랜치 이상 배포된 박스).
#
# 사용:  bash deploy/provision-profile.sh <member-id-or-email>
#   env(선택): LIVELY_PROFILES_ROOT(기본 ~/.lively/profiles) — seam 과 동일 기본값이어야 함(불변식).
#             LIVELY_GATEWAY · LIVELY_TOKEN · KIT_HARNESS 는 install-kit.sh 와 동일 의미로 전달됨.
# ─────────────────────────────────────────────────────────────────────────────
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"   # deploy/
# shellcheck source=lib/common.sh
source "$DIR/lib/common.sh"

MEMBER="${1:-}"
[ -n "$MEMBER" ] || die "사용: bash deploy/provision-profile.sh <member-id-or-email>"
require_cmd node; require_cmd curl
command -v claude >/dev/null 2>&1 || die "claude CLI 없음 — 중앙박스 세션용. 먼저 install.sh(키트 포함) 실행."

# slug — seam(terminal-sessions.ts 의 slug())과 **동일 로직**이어야 프로필 dir 이 일치한다(불변식).
#  seam: s.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"").slice(0,24) || "user"
SLUG="$(node -e 'const s=String(process.argv[1]||"");process.stdout.write(s.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"").slice(0,24)||"user")' "$MEMBER")"
PROFILES_ROOT="${LIVELY_PROFILES_ROOT:-$HOME/.lively/profiles}"
PROFILE_DIR="$PROFILES_ROOT/$SLUG/claude"

log "프로필 프로비저닝 — member=$MEMBER  slug=$SLUG"
log "CLAUDE_CONFIG_DIR=$PROFILE_DIR"
mkdir -p "$PROFILE_DIR"

# 키트를 이 프로필 dir 로: user-install.mjs 가 CLAUDE_CONFIG_DIR 을 보고 settings 를 여기에,
#  register-clients.sh 의 `claude mcp add --scope user` 도 CLAUDE_CONFIG_DIR 을 존중해 .claude.json 을 여기에 쓴다.
#  ~/.lively(공유)는 install-kit.sh 가 HOME 기준으로 (재)설치 — 멱등.
export CLAUDE_CONFIG_DIR="$PROFILE_DIR"
bash "$DIR/install-kit.sh"

echo ""
ok "프로필 키트 설치 완료 — $PROFILE_DIR (settings+MCP 격리, ~/.lively 공유)"
warn "아직 로그인 전 — 이 프로필은 seam 에서 무시되고 세션은 공유 계정으로 폴백한다(무회귀)."
log  "다음(사람 1회): 이 멤버의 Claude 계정으로 로그인 →"
printf '        CLAUDE_CONFIG_DIR=%s claude   # 뜨면 /login\n' "$PROFILE_DIR"
log  "로그인되면(.credentials.json 생성) 이 멤버(slug=$SLUG)가 띄우는 중앙박스 세션이 자동으로 이 계정을 쓴다."
log  "검증:  CLAUDE_CONFIG_DIR=$PROFILE_DIR claude mcp list | grep -i lively   ·   ls -a $PROFILE_DIR"
