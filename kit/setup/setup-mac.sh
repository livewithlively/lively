#!/usr/bin/env bash
set -euo pipefail
# lively 컨텍스트 셋업 — Mac
# ----------------------------------------------------------------
# 하는 일: [1] Claude Code 확인/설치  [2] 토큰 입력 + MCP 게이트웨이 등록  [3] user-level 설치(컨텍스트+훅)  [4] 안내
# 재실행 안전(idempotent): 이미 설치됨 → 건너뜀, 이미 등록됨 → 제거 후 재등록, 훅 머지는 중복 안 만듦.
#
# ▶ 사용법: /install 번들을 푼 폴더에서  bash setup/setup-mac.sh  (또는 한 줄: install-via-curl.sh)
# ▶ 한 번 설치하면 user-level 이라 **어느 폴더에서 claude 를 켜든** 컨텍스트+리플렉스가 따라옵니다(실행 디렉 무의미).
# ▶ 토큰은 조직 관리자가 발급합니다. 환경변수 LIVELY_TOKEN 으로 미리 줘도 됩니다.
# ▶ 제거(영구): bash setup/setup-mac.sh --uninstall [--dry-run|--purge|--harness …]  (uninstall-mac.sh 로 위임)

# ── 제거 디스패치 ───────────────────────────────────────────────
# 첫 인자가 --uninstall 이면 제거 스크립트로 위임(나머지 인자 전달). uninstall ≠ incognito(LIVELY_OFF, 일시 off).
if [ "${1:-}" = "--uninstall" ]; then
  shift
  _SD="$(cd "$(dirname "$0")" && pwd)"
  exec bash "$_SD/uninstall-mac.sh" "$@"
fi

# ── CONFIG ──────────────────────────────────────────────────────
# 라벨·URL 단일 출처: context-ontology/scripts/register-clients.sh — 변경은 거기 먼저.
MCP_LABEL="lively"
# 게이트웨이 URL 은 하드코딩하지 않는다 — LIVELY_GATEWAY 환경변수로 조직 게이트웨이를 지정한다.
# 예: LIVELY_GATEWAY=http://<host>:8080/mcp  (없으면 아래에서 안내 후 중단)
ORG_DEFAULT_URL="${LIVELY_GATEWAY:-}"

echo
echo "=== Lively 컨텍스트 셋업 (Mac) ==="
echo

# ── [1] Claude Code CLI 확인 ────────────────────────────────────
if command -v claude >/dev/null 2>&1; then
  echo "[1] Claude Code: 이미 설치됨 -> 건너뜀"
else
  echo "[1] Claude Code 가 설치되어 있지 않습니다."
  echo "    설치 명령:  curl -fsSL https://claude.ai/install.sh | bash"
  if [ -t 0 ]; then
    read -rp "    지금 설치할까요? [y/N] " yn
    if [[ "${yn:-n}" =~ ^[Yy]$ ]]; then
      curl -fsSL https://claude.ai/install.sh | bash
      # 설치 직후 PATH 반영 (~/.local/bin 표준 설치 경로)
      export PATH="$HOME/.local/bin:$PATH"
      hash -r
      if ! command -v claude >/dev/null 2>&1; then
        echo "    설치는 됐지만 이 창에서 인식되지 않습니다. 터미널을 새로 열고 이 스크립트를 다시 실행하세요."
        exit 1
      fi
      echo "    완료"
    else
      echo "    설치 후 이 스크립트를 다시 실행하세요."
      exit 1
    fi
  else
    echo "    설치 후 이 스크립트를 다시 실행하세요."
    exit 1
  fi
fi

# ── [2] 토큰 + MCP 게이트웨이 등록 ──────────────────────────────
# 토큰 값은 화면/로그에 절대 출력하지 않는다.
if [ -n "${LIVELY_TOKEN:-}" ]; then
  echo "[2] 토큰: LIVELY_TOKEN 환경변수 사용"
  tok="$LIVELY_TOKEN"
else
  read -rsp "[2] 본인 접속 토큰을 붙여넣으세요 (관리자 발급, 입력해도 화면에 안 보임): " tok
  echo
  if [ -z "$tok" ]; then
    echo "    토큰이 비어 있습니다. 관리자에게 토큰을 받아 다시 실행하세요."
    exit 1
  fi
fi

# 등록은 번들된 캐노니컬 스크립트(register-clients.sh)에 위임:
#  - Claude Code: 라벨 ${MCP_LABEL} 로 remove 후 add (재실행 안전)
#  - Codex / openclaw: 붙여넣을 설정 스니펫 출력 (토큰은 env var 참조 — 값 비노출)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -z "$ORG_DEFAULT_URL" ]; then
  echo "    [!] MCP 게이트웨이 URL 이 비어 있습니다 — LIVELY_GATEWAY 환경변수로 조직 게이트웨이를 지정한 뒤 다시 실행하세요." >&2
  echo "        예: LIVELY_GATEWAY=http://<host>:8080/mcp bash setup/setup-mac.sh" >&2
  exit 1
fi
echo "    MCP 게이트웨이 등록: ${ORG_DEFAULT_URL} (라벨: ${MCP_LABEL})"
STORE_URL="$ORG_DEFAULT_URL" LIVELY_TOKEN="$tok" bash "$SCRIPT_DIR/register-clients.sh"

# ── [2.5] 세션 훅용 토큰 파일 (~/.lively) ───────────────────────
# 세션 훅(session-preload 등)이 ~/.lively/token + gateway-url 을 읽는다(훅은 fail-open이라
# 이 파일이 없어도 작업은 막히지 않지만, preload 현황 주입이 조용히 비활성화된다).
# 값은 화면에 출력하지 않는다. 재실행 안전(덮어쓰기).
mkdir -p "$HOME/.lively" && chmod 700 "$HOME/.lively"
printf '%s' "$tok" > "$HOME/.lively/token" && chmod 600 "$HOME/.lively/token"
printf '%s' "${ORG_DEFAULT_URL%/mcp}" > "$HOME/.lively/gateway-url" && chmod 600 "$HOME/.lively/gateway-url"
echo "    세션 훅 토큰 기록: ~/.lively/token (0600)"

# ── [3] user-level 설치 (컨텍스트 + 훅) ─────────────────────────
# 어느 폴더에서 켜든 컨텍스트+리플렉스가 오게 ~/.lively + ~/.claude(비파괴 머지) 에 설치.
# 두 실행 맥락 모두 user-level 설치를 완성한다(D2/D3 — 번들 → setup → 어디서든):
#   (a) kit 안에서 실행: kit 의 adapters/claude/install.mjs (조직콘텐츠 --org 직접 빌드).
#   (b) /install 번들을 푼 폴더에서 실행: 번들 동봉 setup/user-install.mjs (kit 미의존, 번들 자산만으로 설치).
# 둘 다 없으면(node 부재 등) 정적 병행 경로로 안내.
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CLAUDE_ADAPTER="$ROOT_DIR/adapters/claude/install.mjs"
CODEX_ADAPTER="$ROOT_DIR/adapters/codex/install.mjs"
VENDORED="$SCRIPT_DIR/user-install.mjs"          # 발행물 동봉 설치기(claude+codex 모두 — --harness)
USER_LEVEL_DONE=0

# 설치된 하네스 자동 감지 — 있는 것만 각각 user-level 설치한다(둘 다 있으면 둘 다).
HAVE_CLAUDE=0; command -v claude >/dev/null 2>&1 && HAVE_CLAUDE=1
HAVE_CODEX=0;  command -v codex  >/dev/null 2>&1 && HAVE_CODEX=1
echo "[3] 하네스 감지: claude=$([ $HAVE_CLAUDE = 1 ] && echo o || echo x) codex=$([ $HAVE_CODEX = 1 ] && echo o || echo x)"

if command -v node >/dev/null 2>&1 && [ -f "$CLAUDE_ADAPTER" ]; then
  # (a) kit 안 — 조직콘텐츠 위치: env LIVELY_ORG_DIR 우선, 없으면 제품(workflow-std) 옆 org-content 추정(조직명 비하드코딩).
  ORG_DIR="${LIVELY_ORG_DIR:-$ROOT_DIR/../org-content}"
  if [ -d "$ORG_DIR/org" ]; then
    if [ $HAVE_CLAUDE = 1 ]; then
      echo "[3a] Claude user-level 설치 (kit 어댑터 — 컨텍스트 + 훅)"
      node "$CLAUDE_ADAPTER" --org "$ORG_DIR" ${LIVELY_ORG_NAME:+--org-name "$LIVELY_ORG_NAME"} ${LIVELY_WORK_ROOT:+--work-root "$LIVELY_WORK_ROOT"}
      USER_LEVEL_DONE=1
    fi
    if [ $HAVE_CODEX = 1 ] && [ -f "$CODEX_ADAPTER" ]; then
      echo "[3b] Codex user-level 설치 (kit 어댑터 — config.toml [hooks]+[mcp_servers.lively] + AGENTS.md)"
      node "$CODEX_ADAPTER" --org "$ORG_DIR" ${LIVELY_ORG_NAME:+--org-name "$LIVELY_ORG_NAME"} ${LIVELY_WORK_ROOT:+--work-root "$LIVELY_WORK_ROOT"}
      USER_LEVEL_DONE=1
    fi
    [ $HAVE_CLAUDE = 0 ] && [ $HAVE_CODEX = 0 ] && echo "[3] claude/codex 둘 다 미설치 — user-level 설치 건너뜀(MCP 등록만 위 단계에서 완료)."
  else
    echo "[3] 조직콘텐츠($ORG_DIR/org) 미발견 — user-level 설치 건너뜀(LIVELY_ORG_DIR 로 지정 가능)."
  fi
elif command -v node >/dev/null 2>&1 && [ -f "$VENDORED" ]; then
  # (b) /install 번들 안 — 번들 동봉 설치기(user-install.mjs)가 감지된 하네스 모두 설치.
  HARNESS_LIST=""
  [ $HAVE_CLAUDE = 1 ] && HARNESS_LIST="claude"
  [ $HAVE_CODEX = 1 ] && HARNESS_LIST="${HARNESS_LIST:+$HARNESS_LIST,}codex"
  if [ -n "$HARNESS_LIST" ]; then
    echo "[3] user-level 설치 (발행물 동봉 설치기 — harness=$HARNESS_LIST)"
    node "$VENDORED" --clone-root "$ROOT_DIR" --harness "$HARNESS_LIST" ${LIVELY_WORK_ROOT:+--work-root "$LIVELY_WORK_ROOT"}
    USER_LEVEL_DONE=1
  else
    echo "[3] claude/codex 둘 다 미설치 — user-level 설치 건너뜀."
  fi
elif [ -d "$ROOT_DIR/org" ] || [ -f "$ROOT_DIR/AGENTS.md" ]; then
  echo "[3] node 미발견 — user-level 설치 불가."
  echo "    이 폴더에서 직접 \`claude\` 를 켜면 정적 CLAUDE.md/AGENTS.md 가 자동 로드됩니다(병행 경로)."
  echo "    Node.js 설치 후 setup 을 다시 실행하면 어디서든 켜는 user-level 설치가 됩니다."
else
  echo "[3] node 또는 설치기 미발견 — user-level 설치 건너뜀."
fi

# ── [4] 마무리 ──────────────────────────────────────────────────
echo
echo "=== 끝! 이렇게 시작하세요 ==="
echo "  1) 등록 확인:  claude mcp list"
if [ "$USER_LEVEL_DONE" = "1" ]; then
  echo "  2) **아무 폴더**(자기 코드 레포 포함)에서 \`claude\` 를 켜면 회사 맥락+리플렉스가 따라옵니다."
  echo "     (user-level 설치 — 실행 디렉토리 무의미. 훅은 설정 스냅샷 특성상 **다음 세션부터** 적용.)"
else
  echo "  2) 이 폴더(/install 번들 루트)에서 \`claude\` 를 켜세요(정적 컨텍스트 자동 로드)."
fi
echo "  · incognito(전부 off): 환경변수 LIVELY_OFF=1"
if [ "$HAVE_CODEX" = "1" ]; then
  echo
  echo "  [Codex 멤버 추가 안내]"
  echo "   - 셸 rc 에 LIVELY_TOKEN export 를 심었습니다(토큰 리터럴 아님 — ~/.lively/token 런타임 읽기)."
  echo "     **새 터미널을 열거나 \`source ~/.zshrc\` 후** codex 를 켜야 lively MCP 가 인증됩니다(확인: codex mcp list)."
  echo "   - 첫 대화형 세션에서 \`/hooks\` 로 lively 훅을 한 번 신뢰해야 리플렉스(컨텍스트 주입/Stop 게이트)가 작동합니다."
  echo "   - 헤드리스(\`codex exec\`)는 라이프사이클 훅이 안 돕니다(0.138.0) — AGENTS.md 정적 컨텍스트만 옵니다."
fi
echo
echo "처음 실행이면 브라우저 로그인 창이 뜹니다(회사 계정으로 로그인)."
