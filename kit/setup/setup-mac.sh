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
# 폴백: LIVELY_GATEWAY 미지정이고 이미 설치된 머신이면 ~/.lively/gateway-url 에서 복원한다(업데이트·재실행 경로).
# (gateway-url 은 /mcp 없이 저장되므로 다시 붙인다. 신규 설치는 이 파일이 없어 빈 값 유지 → 아래에서 안내 후 중단.)
if [ -z "$ORG_DEFAULT_URL" ] && [ -r "$HOME/.lively/gateway-url" ]; then
  _gw="$(cat "$HOME/.lively/gateway-url")"; _gw="${_gw%/}"
  if [ -n "$_gw" ]; then case "$_gw" in */mcp) ORG_DEFAULT_URL="$_gw";; *) ORG_DEFAULT_URL="$_gw/mcp";; esac; fi
fi

# ── Node 부트스트랩 + PATH 영속화 (#355) ────────────────────────
# 새 맥의 두 함정을 자동으로 없앤다:
#   (1) claude 설치기는 ~/.local/bin 에 설치만 하고 PATH 영속화는 사용자 몫으로 남긴다(경고만 출력)
#       → 새 터미널에서 `claude` 가 안 잡힘.  (2) node 가 없어 user-level 설치([3])와 세션 훅
#       (전부 `node …`)이 통째로 죽고, 그 폴백으로 "번들 폴더에서 실행"만 안내돼 경로 혼란이 생김.
# 여기서 node 를 무sudo(~/.lively/runtime)로 설치하고, claude·node bin 을 셸 rc 에 비파괴로 영속화한다.
PATH_ORIG="$PATH"                       # PATH 변경 전 스냅샷(새-셸 PATH 프록시 — rc 중복 방지 판정용)
NODE_BOOTSTRAPPED=0                      # 이번 실행에서 node 를 새로 설치했는지(마무리 재시작 안내 분기 — #355)
NODE_FALLBACK_VERSION="v22.14.0"        # index.json 해석 실패 시 폴백(공식 LTS · 실재 확인됨)
NODE_MIN_MAJOR=20                       # 최소 Node — package.json engines(">=20") · kit/cli/bootstrap.sh 와 같은 계약(#1068)
LIVELY_NODE_DIR="$HOME/.lively/runtime" # 번들 Node 런타임 위치(~/.lively 하위 → 제거 시 함께 삭제)
PATH_A_BEGIN="# >>> lively-managed (PATH: local-bin) >>>"   # claude 등 ~/.local/bin — 제거해도 보존(claude 소유)
PATH_A_END="# <<< lively-managed (PATH: local-bin) <<<"
PATH_B_BEGIN="# >>> lively-managed (PATH: node) >>>"        # 번들 node — uninstall 시 제거
PATH_B_END="# <<< lively-managed (PATH: node) <<<"

# 설치된(번들) node bin 경로를 echo. 없으면 비어있음 + 비0.
lively_node_bin() { [ -x "$LIVELY_NODE_DIR/current/bin/node" ] && { echo "$LIVELY_NODE_DIR/current/bin"; return 0; }; return 1; }

# 최신 LTS 버전 해석(node 불필요 — curl/tr/grep/sed). 실패 시 폴백.
resolve_node_version() {
  local v maj
  v="$(curl -fsSL --max-time 15 https://nodejs.org/dist/index.json 2>/dev/null \
      | tr '}' '\n' | grep -m1 '"lts":"' | sed -E 's/.*"version":"(v[0-9][0-9.]*)".*/\1/')" || true
  case "$v" in v[0-9]*) ;; *) v="$NODE_FALLBACK_VERSION" ;; esac
  # 해석이 어긋나 최소 버전 미만을 집어오면 이 게이트가 통째로 무의미해진다 — 그 땐 폴백(고정 LTS)으로.
  maj="${v#v}"; maj="${maj%%.*}"
  case "$maj" in ''|*[!0-9]*) v="$NODE_FALLBACK_VERSION" ;; esac
  [ "${maj:-0}" -ge "$NODE_MIN_MAJOR" ] 2>/dev/null || v="$NODE_FALLBACK_VERSION"
  printf '%s' "$v"
}

# 이 node 가 쓸 만한가 — **존재가 아니라 버전으로 판정한다**(#1068, kit/cli/bootstrap.sh 와 같은 계약).
#  user-install.mjs 도 세션 훅도 전역 fetch(Node 18+)를 쓰므로, 구버전 node 를 채택하면 설치 한복판에서
#  `fetch is not defined` 로 죽는다(실측: 시스템 v16.20.2). 못 쓸 버전은 **없는 것으로 취급**하고 우리 것을 깐다.
node_usable() {
  local exe="${1:-}" m
  [ -n "$exe" ] && [ -x "$exe" ] || return 1
  m="$("$exe" -p 'process.versions.node.split(".")[0]' 2>/dev/null || printf '0')"
  case "$m" in ''|*[!0-9]*) return 1 ;; esac
  [ "$m" -ge "$NODE_MIN_MAJOR" ]
}

# node 확보: 시스템 node 가 쓸 만하면 사용; 아니면 공식 tarball 을 ~/.lively/runtime 에 설치(무sudo·체크섬 검증). 성공 시 0.
#   opt-out: LIVELY_NO_NODE=1 · 무프롬프트 강제: LIVELY_AUTO_NODE=1(비대화형은 자동).
ensure_node() {
  local sys; sys="$(command -v node 2>/dev/null || true)"
  node_usable "$sys" && return 0
  # 시스템 node 는 건드리지 않는다 — PATH 앞에 우리 런타임을 얹어 이 실행 안에서만 가린다.
  [ -n "$sys" ] && echo "[1.5] 시스템 node($("$sys" -v 2>/dev/null || echo '버전 확인 실패')) 는 Node ${NODE_MIN_MAJOR} 미만 — 라이블리 전용 런타임을 씁니다(시스템 node 는 그대로)."
  local bin; bin="$(lively_node_bin || true)"
  if [ -n "$bin" ] && node_usable "$bin/node"; then export PATH="$bin:$PATH"; hash -r; echo "[1.5] Node: 번들 런타임 재사용($(node -v))"; return 0; fi
  if [ "${LIVELY_NO_NODE:-0}" = "1" ]; then echo "[1.5] Node: LIVELY_NO_NODE=1 — 자동설치 건너뜀."; return 1; fi
  if [ -t 0 ] && [ "${LIVELY_AUTO_NODE:-0}" != "1" ]; then
    echo "[1.5] Node.js 가 없습니다(user-level 설치·세션 훅에 필요)."
    local yn; read -rp "      ~/.lively 에 자동 설치할까요(무sudo, lively 제거 시 함께 삭제)? [Y/n] " yn || true
    case "${yn:-y}" in [Nn]*) echo "      건너뜁니다(정적 병행 경로로 폴백)."; return 1 ;; esac
  else
    echo "[1.5] Node.js 미발견 — 자동 설치합니다(무sudo · ~/.lively/runtime)."
  fi
  local uarch tararch; uarch="$(uname -m)"
  case "$uarch" in
    arm64|aarch64) tararch="arm64" ;;
    x86_64|amd64)  tararch="x64" ;;
    *) echo "      ⚠ 미지원 CPU 아키텍처($uarch) — Node 자동설치 건너뜀. 수동 설치 후 재실행하세요."; return 1 ;;
  esac
  local ver base url sumurl tmp; ver="$(resolve_node_version)"
  base="node-${ver}-darwin-${tararch}"
  url="https://nodejs.org/dist/${ver}/${base}.tar.gz"
  sumurl="https://nodejs.org/dist/${ver}/SHASUMS256.txt"
  tmp="$(mktemp -d)"
  echo "      Node ${ver} (${tararch}) 다운로드 중… (~30MB, 관리자권한 불필요)"
  if ! curl -fsSL --max-time 180 "$url" -o "$tmp/node.tgz"; then
    echo "      ✗ Node 다운로드 실패(네트워크?) — 건너뜁니다. 나중에 setup 을 다시 실행하면 재시도합니다."; rm -rf "$tmp"; return 1
  fi
  # 무결성 검증(공급망 위생): SHASUMS256 확보되면 강제(불일치 중단), 못 받으면 경고 후 진행(TLS 다운로드).
  if curl -fsSL --max-time 30 "$sumurl" -o "$tmp/SHASUMS256.txt" 2>/dev/null; then
    local want got
    want="$(awk -v f="${base}.tar.gz" '$2==f{print $1}' "$tmp/SHASUMS256.txt")"
    got="$(shasum -a 256 "$tmp/node.tgz" | awk '{print $1}')"
    if [ -n "$want" ] && [ "$want" != "$got" ]; then
      echo "      ✗ Node 체크섬 불일치 — 설치 중단(무결성 실패)."; rm -rf "$tmp"; return 1
    fi
    [ -n "$want" ] && echo "      ✓ 체크섬 검증 통과"
  else
    echo "      · SHASUMS256 확보 실패 — 체크섬 생략(TLS 다운로드로 진행)."
  fi
  mkdir -p "$LIVELY_NODE_DIR"
  rm -rf "${LIVELY_NODE_DIR:?}/$base"
  if ! tar -xzf "$tmp/node.tgz" -C "$LIVELY_NODE_DIR"; then echo "      ✗ Node 압축 해제 실패."; rm -rf "$tmp"; return 1; fi
  rm -rf "$tmp"
  ln -sfn "$LIVELY_NODE_DIR/$base" "$LIVELY_NODE_DIR/current"   # 버전 무관 안정 경로(rc·uninstall 이 참조)
  local nbin="$LIVELY_NODE_DIR/current/bin"
  [ -x "$nbin/node" ] || { echo "      ✗ Node 설치 확인 실패."; return 1; }
  export PATH="$nbin:$PATH"; hash -r
  NODE_BOOTSTRAPPED=1
  echo "      ✓ Node 설치 완료: ~/.lively/runtime/$base ($("$nbin/node" -v))"
  return 0
}

# rc 한 개에 센티넬 블록을 비파괴로 머지(백업·멱등). $1=BEGIN $2=END $3=블록전문 $4=라벨
_wire_rc_block() {
  local BEGIN="$1" END="$2" block="$3" label="$4"
  local targets=() f
  for f in .zshrc .bashrc .bash_profile .profile; do [ -f "$HOME/$f" ] && targets+=("$HOME/$f"); done
  [ ${#targets[@]} -eq 0 ] && targets=("$HOME/.zshrc")
  mkdir -p "$HOME/.lively/backups" 2>/dev/null || true
  local rc short
  for rc in "${targets[@]}"; do
    short="${rc/#$HOME/~}"
    if [ -f "$rc" ] && grep -qF "$BEGIN" "$rc" 2>/dev/null; then echo "      · $short ($label 블록 기존 유지)"; continue; fi
    local bak="$HOME/.lively/backups/$(basename "$rc").path.bak"   # 최초(pristine) 스냅샷만 유지 — 덮어쓰지 않음
    [ -f "$rc" ] && [ ! -f "$bak" ] && cp "$rc" "$bak" 2>/dev/null || true
    { [ -s "$rc" ] && printf '\n'; printf '%s\n' "$block"; } >> "$rc"
    echo "      ✓ $short 에 $label 블록 추가"
  done
}

# claude(~/.local/bin)·번들 node bin 을 셸 rc 에 영속화 → 새 터미널·클로드 훅에서도 잡힘.
wire_path_rc() {
  local wired=0
  if [ -d "$HOME/.local/bin" ]; then
    case ":$PATH_ORIG:" in
      *":$HOME/.local/bin:"*) : ;;   # 이미 새-셸 PATH 에 있음 — 스킵(중복 방지)
      *) _wire_rc_block "$PATH_A_BEGIN" "$PATH_A_END" \
"$PATH_A_BEGIN
# claude 등 ~/.local/bin 의 사용자 바이너리를 PATH 에 추가(claude 설치기가 안내하던 그 줄 — lively 가 자동 적용).
# lively 제거 후에도 남깁니다 — claude 는 사용자 소유라 계속 필요할 수 있습니다.
if [ -d \"\$HOME/.local/bin\" ]; then case \":\$PATH:\" in *\":\$HOME/.local/bin:\"*) ;; *) export PATH=\"\$HOME/.local/bin:\$PATH\" ;; esac; fi
$PATH_A_END" "PATH(local-bin)"; wired=1 ;;
    esac
  fi
  if [ -x "$LIVELY_NODE_DIR/current/bin/node" ]; then
    _wire_rc_block "$PATH_B_BEGIN" "$PATH_B_END" \
"$PATH_B_BEGIN
# lively 번들 Node 런타임을 PATH 에 — 세션 훅(node)·설치기 실행에 필요(lively 제거 시 함께 정리됨).
if [ -x \"\$HOME/.lively/runtime/current/bin/node\" ]; then case \":\$PATH:\" in *\":\$HOME/.lively/runtime/current/bin:\"*) ;; *) export PATH=\"\$HOME/.lively/runtime/current/bin:\$PATH\" ;; esac; fi
$PATH_B_END" "PATH(node)"; wired=1
  fi
  [ "$wired" = 1 ] && echo "      (현재 셸엔 이미 반영됨 — 새 터미널부터 위 rc 가 자동 적용)"
  return 0
}

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

# ── [1.5] Node.js 확인/부트스트랩 (#355) ────────────────────────
# node 는 user-level 설치([3])와 세션 훅(전부 `node …`)의 런타임이다. 없으면 여기서 무sudo 설치한다.
# (실패/거절해도 아래 단계는 계속 — 정적 병행 경로로 폴백.)
ensure_node || true

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
  echo "    아래 폴더에서 직접 \`claude\` 를 켜면 정적 CLAUDE.md/AGENTS.md 가 자동 로드됩니다(병행 경로):"
  echo "        cd \"$ROOT_DIR\" && claude"
  echo "    Node.js 설치 후 setup 을 다시 실행하면 어디서든 켜는 user-level 설치가 됩니다."
else
  echo "[3] node 또는 설치기 미발견 — user-level 설치 건너뜀."
fi

# ── [3.5] PATH 영속화 (#355) ────────────────────────────────────
# claude(~/.local/bin)·번들 node bin 을 셸 rc 에 비파괴로 심어, 새 터미널과 클로드 세션 훅(bare `node`)
# 에서도 잡히게 한다. (claude 설치기는 이 영속화를 안 해줘 `claude` not found 를 유발하던 버그를 없앰.)
echo "[3.5] PATH 영속화(claude·node — 새 터미널/훅용)"
wire_path_rc

# ── [4] 마무리 ──────────────────────────────────────────────────
echo
echo "=== 끝! 이렇게 시작하세요 ==="
echo "  1) 등록 확인:  claude mcp list"
if [ "$USER_LEVEL_DONE" = "1" ]; then
  echo "  2) **아무 폴더**(자기 코드 레포 포함)에서 \`claude\` 를 켜면 회사 맥락+리플렉스가 따라옵니다."
  echo "     (user-level 설치 — 실행 디렉토리 무의미. 훅은 설정 스냅샷 특성상 **다음 세션부터** 적용.)"
else
  echo "  2) 아래 폴더에서 \`claude\` 를 켜세요(정적 컨텍스트 자동 로드):"
  echo "         cd \"$ROOT_DIR\" && claude"
  echo "     · 이 경로가 /tmp 아래면 재부팅 시 사라질 수 있습니다 — Node.js 설치 후 setup 을 다시 실행하면"
  echo "       어느 폴더에서 켜든 따라오는 user-level 설치가 됩니다(위 [1.5] 에서 Node 자동설치 시도)."
fi
echo "  3) **예전에 쓰시던 AI 환경이 있다면** — \`claude\` 를 켜고 이렇게 물어보세요:"
echo "         온보딩 도와줘"
echo "     예전 작업 메모리·스킬·MCP 연결·레포를 **읽기만** 해서 보여주고, 무엇을 라이블리로 올리고"
echo "     무엇을 그대로 둘지 함께 정리합니다. **원본은 건드리지 않습니다**(복사만 — 지우거나 덮어쓰지 않음)."
echo "     ※ 예전 메모리가 '사라진' 것처럼 보여도 지워진 게 아닙니다 — 폴더마다 따로 저장돼 안 보일 뿐이고, 위 도우미가 찾아줍니다."
echo "  · incognito(전부 off): 환경변수 LIVELY_OFF=1"
if [ "$NODE_BOOTSTRAPPED" = "1" ]; then
  echo
  echo "  ⚠ 방금 Node.js 를 새로 설치했습니다(무sudo · ~/.lively/runtime)."
  echo "    **지금 열려있던 터미널/claude 세션**은 아직 이 경로를 몰라, 그 세션의 훅이"
  echo "    'node: command not found' 로 실패할 수 있습니다(페르소나 미주입 · Stop 게이트 무작동)."
  echo "    → **새 터미널을 열거나  source ~/.zshrc  한 뒤, claude 를 완전히 종료하고 다시 켜세요.**"
  echo "    (이 설치로 다음 세션부터는 훅이 node 절대경로로 실행돼 이 문제가 재발하지 않습니다.)"
fi
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

# ── 온보딩 바로 시작 제안 (대화형 tty 일 때만 — [ -t 0 ] 가드는 위 claude 설치 프롬프트와 동일 관례) ──
#  node 를 방금 부트스트랩했으면(현재 셸에 node 경로 없음 → 훅 실패) 제안하지 않는다 — 위 재시작 안내를 먼저 따르게 둔다.
if [ -t 0 ] && [ "$NODE_BOOTSTRAPPED" != "1" ] && command -v claude >/dev/null 2>&1; then
  echo
  read -rp "지금 온보딩을 바로 시작할까요? (예전 AI 환경 정리·첫 세팅) [Y/n] " _ob || true
  if [[ ! "${_ob:-Y}" =~ ^[Nn] ]]; then
    echo "  · 온보딩 세션을 엽니다 — 회사 맥락은 다음 세션부터 붙습니다(스킬은 로컬 파일만 읽어 지금도 동작)."
    exec claude "온보딩 도와줘"
  fi
  echo "  · 나중에 언제든:  \`lively onboarding\`  또는  claude 에서  \"온보딩 도와줘\""
fi
