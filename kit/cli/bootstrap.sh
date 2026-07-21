#!/bin/sh
# lively 부트스트랩 (#864) — 웹에서 복사하는 **유일한** 명령. 토큰을 담지 않는다.
#
#   curl -fsSL https://<게이트웨이>/cli | sh
#
# 하는 일은 딱 넷: [1] Node 확보  [2] lively CLI 설치  [3] PATH 배선  [4] `lively setup` 으로 인계.
# 실제 설치(키트·훅·MCP 등록)는 전부 CLI(Node)가 한다 — 이 셸 스크립트는 **CLI 를 손에 쥐여주는 것까지**만 한다.
#   → 그래서 mac/linux 가 같은 코드로 돌고, PowerShell 판(bootstrap.ps1)과도 역할이 정확히 대칭이다.
#
# 왜 토큰이 없나 — 종전 설치 한 줄은 장기 토큰을 명령줄에 박아 ~/.zsh_history 에 영구히 남겼다.
#  이제 토큰은 [4] 의 `lively login` 이 /dev/tty 가림 입력으로 받는다(화면·히스토리·클립보드 어디에도 안 남음).
#
# 재실행 안전(idempotent): 이미 있는 건 건너뛰고, 기존 토큰·설정은 건드리지 않는다.
set -eu

# 게이트웨이가 서빙 시점에 자기 주소를 굽는다(src/web.ts 의 /cli 라우트). 로컬 테스트는 LIVELY_GATEWAY 로 덮어쓴다.
GW="${LIVELY_GATEWAY:-__LIVELY_GATEWAY__}"
GW="${GW%/}"

# ⚠ LIVELY_HOME 은 **HOME 리다이렉트**다(.lively 디렉터리가 아니라) — user-install/uninstall/self-update 와 같은 계약.
LIVELY_DIR="${LIVELY_HOME:-$HOME}/.lively"
NODE_DIR="$LIVELY_DIR/runtime"
NODE_FALLBACK="v22.14.0"   # nodejs.org/dist/index.json 해석 실패 시 폴백(공식 LTS · 실재 확인됨)
NODE_MIN_MAJOR=20          # CLI·훅이 요구하는 최소 Node — package.json engines(">=20") · lively.mjs 의 NODE_MIN_MAJOR 와 같은 계약.

say()  { printf '%s\n' "$*" >&2; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*" >&2; }
info() { printf '  \033[2m·\033[0m %s\n' "$*" >&2; }
die()  { printf '\n\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

case "$GW" in
  http://*|https://*) ;;
  *) die "게이트웨이 주소가 올바르지 않습니다: '$GW'" ;;
esac

say ""
say "=== 라이블리 설치 ==="
say ""

# ── [1] Node 확보 ─────────────────────────────────────────────────────────────
# CLI 도 훅도 전부 Node 다. 없으면 공식 tarball 을 **무sudo**로 ~/.lively/runtime 에 깐다(체크섬 검증).
#  setup-mac.sh 의 ensure_node 와 같은 계약이되 Linux 까지 커버한다(박스·WSL·리눅스 노트북).
#
# ⚠ **존재가 아니라 버전으로 판정한다**(#1068). 옛 코드는 `command -v node` 하나로 시스템 node 를 무조건
#   채택해서, 구버전 박스에선 CLI 가 그 위에서 돌다 `fetch is not defined`(전역 fetch 는 Node 18+)로
#   [1/3] 키트 내려받기에서 죽었다(실측: 시스템 v16.20.2). 아래 [2] 의 심은 번들 런타임을 우선하지만,
#   **여기서 안 깔면 심이 쥘 게 없어** 결국 같은 구버전 node 로 폴백한다 — 그래서 심의 약속("시스템 node 가
#   구버전이어도 CLI 는 항상 최신 런타임에서 돈다")을 실제로 성립시키는 건 이 블록이다.
#   판정 규칙: **못 쓸 버전 = 없는 것**. 시스템 node 는 건드리지 않고 우리 것만 따로 깐다.
node_usable() {
  [ -n "${1:-}" ] && [ -x "$1" ] || return 1
  m="$("$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || printf '0')"
  case "$m" in ''|*[!0-9]*) return 1 ;; esac
  [ "$m" -ge "$NODE_MIN_MAJOR" ]
}
SYS_NODE="$(command -v node 2>/dev/null || true)"
BUNDLED_NODE="$NODE_DIR/current/bin/node"
# 구버전이라 못 쓰는 경우에만 안내한다(정상 경로는 조용히 지나간다).
#  ⚠ `return 0` 은 장식이 아니다 — 이 함수는 `set -e` 아래에서 **맨몸으로 호출**된다. 마지막 명령이
#    `[ -n "$SYS_NODE" ]` 로 끝나면 시스템 node 가 없는 박스(=신규 설치의 대다수)에서 함수가 non-zero 를
#    반환하고, 셸이 거기서 스크립트를 통째로 끝낸다 — 배너만 찍고 **아무 말 없이 종료**된다(실측).
#    AND-list(`a && b`)는 set -e 예외지만 **그걸 본문 끝에 둔 함수의 반환값은 예외가 아니다.**
say_old_sys_node() {
  [ -n "$SYS_NODE" ] && info "시스템 node($("$SYS_NODE" -v 2>/dev/null || echo '버전 확인 실패')) 는 Node ${NODE_MIN_MAJOR} 미만 — $1"
  return 0
}
NODE=""
if node_usable "$SYS_NODE"; then
  NODE="$SYS_NODE"
  ok "Node: 시스템 설치 사용 ($("$NODE" -v))"
elif node_usable "$BUNDLED_NODE"; then
  NODE="$BUNDLED_NODE"
  say_old_sys_node "라이블리 전용 런타임을 씁니다(시스템 node 는 그대로 둡니다)."
  ok "Node: 번들 런타임 재사용 ($("$NODE" -v))"
else
  say_old_sys_node "라이블리 전용 런타임을 설치합니다(시스템 node 는 그대로 둡니다)."
  case "$(uname -s)" in
    Darwin) NOS="darwin" ;;
    Linux)  NOS="linux" ;;
    *) die "지원하지 않는 OS: $(uname -s) — Windows 는 PowerShell 에서:  irm $GW/cli.ps1 | iex" ;;
  esac
  case "$(uname -m)" in
    arm64|aarch64) NARCH="arm64" ;;
    x86_64|amd64)  NARCH="x64" ;;
    *) die "지원하지 않는 CPU: $(uname -m) — Node 를 직접 설치한 뒤(https://nodejs.org) 다시 실행하세요." ;;
  esac
  NVER="$(curl -fsSL --max-time 15 https://nodejs.org/dist/index.json 2>/dev/null \
        | tr '}' '\n' | grep -m1 '"lts":"' | sed -E 's/.*"version":"(v[0-9][0-9.]*)".*/\1/' || true)"
  case "${NVER:-}" in v[0-9]*) ;; *) NVER="$NODE_FALLBACK" ;; esac
  # 해석이 어긋나 최소 버전 미만을 집어오면 이 수정이 통째로 무의미해진다 — 그 땐 폴백(고정 LTS)으로.
  NMAJ="$(printf '%s' "${NVER#v}" | cut -d. -f1)"
  if ! { [ -n "$NMAJ" ] && [ "$NMAJ" -ge "$NODE_MIN_MAJOR" ] 2>/dev/null; }; then NVER="$NODE_FALLBACK"; fi
  BASE="node-${NVER}-${NOS}-${NARCH}"
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT INT TERM
  info "Node ${NVER} (${NARCH}) 내려받는 중… (~30MB · 관리자 권한 불필요)"
  curl -fsSL --max-time 300 "https://nodejs.org/dist/${NVER}/${BASE}.tar.gz" -o "$TMP/node.tgz" \
    || die "Node 다운로드 실패 — 네트워크를 확인하고 다시 실행하세요."
  # 무결성 검증(공급망 위생): SHASUMS256 을 받으면 **불일치 시 중단**. 못 받으면 TLS 다운로드로 진행(경고).
  if curl -fsSL --max-time 30 "https://nodejs.org/dist/${NVER}/SHASUMS256.txt" -o "$TMP/sums" 2>/dev/null; then
    if command -v shasum >/dev/null 2>&1; then GOT="$(shasum -a 256 "$TMP/node.tgz" | awk '{print $1}')"
    elif command -v sha256sum >/dev/null 2>&1; then GOT="$(sha256sum "$TMP/node.tgz" | awk '{print $1}')"
    else GOT=""; fi
    WANT="$(awk -v f="${BASE}.tar.gz" '$2==f{print $1}' "$TMP/sums")"
    if [ -n "$GOT" ] && [ -n "$WANT" ] && [ "$GOT" != "$WANT" ]; then
      die "Node 체크섬 불일치 — 설치를 중단합니다(무결성 실패)."
    fi
    [ -n "$WANT" ] && [ -n "$GOT" ] && info "체크섬 검증 통과"
  else
    info "SHASUMS256 확보 실패 — 체크섬 생략(TLS 다운로드로 진행)"
  fi
  mkdir -p "$NODE_DIR"
  rm -rf "${NODE_DIR:?}/$BASE"
  tar -xzf "$TMP/node.tgz" -C "$NODE_DIR" || die "Node 압축 해제 실패."
  ln -sfn "$NODE_DIR/$BASE" "$NODE_DIR/current"   # 버전 무관 안정 경로(심·훅·uninstall 이 참조)
  NODE="$NODE_DIR/current/bin/node"
  [ -x "$NODE" ] || die "Node 설치 확인 실패."
  rm -rf "$TMP"; trap - EXIT INT TERM
  ok "Node 설치 완료: ~/.lively/runtime/$BASE ($("$NODE" -v))"
fi

# ── [2] lively CLI ────────────────────────────────────────────────────────────
# /cli/lively.mjs 는 **무인증** 라우트다 — 코드일 뿐 비밀이 없다(/ui 정적 자산과 같은 성격).
#  설치 후엔 이 파일이 /install 번들에도 들어 있어(kit_version 지문 포함) 자동 업데이트로 함께 갱신된다.
mkdir -p "$LIVELY_DIR/lib" "$LIVELY_DIR/bin"
chmod 700 "$LIVELY_DIR" 2>/dev/null || true
# ⚠ 임시 파일도 **.mjs 확장자를 유지**해야 한다 — `node --check` 는 확장자로 모듈 종류를 판정한다.
#  `lively.mjs.new` 처럼 받으면 CommonJS 로 파싱돼 최상위 import 가 SyntaxError → 멀쩡한 CLI 를 '손상'으로 거부한다(실측).
TMPCLI="$LIVELY_DIR/lib/.lively-download.mjs"
curl -fsSL --max-time 60 "$GW/cli/lively.mjs" -o "$TMPCLI" \
  || die "CLI 다운로드 실패 — 게이트웨이 주소를 확인하세요: $GW"
# 프록시가 로그인 HTML 을 200 으로 돌려주는 사고를 여기서 잡는다(쓰레기를 lively.mjs 로 앉히지 않는다).
"$NODE" --check "$TMPCLI" 2>/dev/null \
  || { rm -f "$TMPCLI"; die "내려받은 CLI 가 손상됐습니다 — 게이트웨이 주소를 확인하세요: $GW"; }
mv -f "$TMPCLI" "$LIVELY_DIR/lib/lively.mjs"
chmod 755 "$LIVELY_DIR/lib/lively.mjs"

# 런처 심 — 번들 Node 를 최우선으로 쓴다(시스템 node 가 구버전이어도 CLI 는 항상 최신 런타임에서 돈다).
cat > "$LIVELY_DIR/bin/lively" <<'SHIM'
#!/bin/sh
# lively 런처 — lively CLI 를 적절한 Node 로 실행한다. (kit/cli/bootstrap.sh · user-install.mjs 가 생성)
set -e
LV="${LIVELY_HOME:-$HOME}/.lively"
N="$LV/runtime/current/bin/node"
[ -x "$N" ] || N="$(command -v node 2>/dev/null || true)"
[ -n "$N" ] || { echo "lively: Node 를 찾을 수 없습니다. 다시 설치하세요:  curl -fsSL <게이트웨이>/cli | sh" >&2; exit 1; }
exec "$N" "$LV/lib/lively.mjs" "$@"
SHIM
chmod 755 "$LIVELY_DIR/bin/lively"
ok "lively 설치: ~/.lively/bin/lively"

# 게이트웨이 주소 기록 — `lively login` 이 어디에 물어볼지 알게 된다(토큰은 여기 없다).
printf '%s' "$GW" > "$LIVELY_DIR/gateway-url"
chmod 600 "$LIVELY_DIR/gateway-url" 2>/dev/null || true

# ── [3] PATH 배선 ─────────────────────────────────────────────────────────────
# 새 터미널에서도 `lively` 가 잡히게 셸 rc 에 센티넬 블록을 **비파괴로** 심는다(이미 있으면 건너뜀).
#  같은 센티넬을 user-install.mjs 도 쓰고 user-uninstall.mjs 가 제거한다 — 세 곳이 한 리터럴을 공유한다.
PATH_BEGIN="# >>> lively-managed (PATH: cli) >>>"
PATH_END="# <<< lively-managed (PATH: cli) <<<"
RC_TARGETS=""
for f in .zshrc .bashrc .bash_profile .profile; do
  [ -f "$HOME/$f" ] && RC_TARGETS="$RC_TARGETS $HOME/$f"
done
[ -z "$RC_TARGETS" ] && { touch "$HOME/.zshrc"; RC_TARGETS="$HOME/.zshrc"; }
mkdir -p "$LIVELY_DIR/backups" 2>/dev/null || true
for rc in $RC_TARGETS; do
  if grep -qF "$PATH_BEGIN" "$rc" 2>/dev/null; then
    info "$(printf '%s' "$rc" | sed "s#^$HOME#~#") (PATH 블록 기존 유지)"
    continue
  fi
  bak="$LIVELY_DIR/backups/$(basename "$rc").path-cli.bak"    # 최초(pristine) 스냅샷만 — 덮어쓰지 않음
  [ -f "$rc" ] && [ ! -f "$bak" ] && cp "$rc" "$bak" 2>/dev/null || true
  {
    [ -s "$rc" ] && printf '\n'
    printf '%s\n' "$PATH_BEGIN"
    printf '%s\n' '# lively CLI 를 PATH 에 추가(제거 시 함께 정리됨).'
    printf '%s\n' 'if [ -d "$HOME/.lively/bin" ]; then case ":$PATH:" in *":$HOME/.lively/bin:"*) ;; *) export PATH="$HOME/.lively/bin:$PATH" ;; esac; fi'
    printf '%s\n' "$PATH_END"
  } >> "$rc"
  ok "$(printf '%s' "$rc" | sed "s#^$HOME#~#") 에 PATH 블록 추가"
done

PATH="$LIVELY_DIR/bin:$PATH"
export PATH

# ── [4] 인계 — 로그인 + 설치 ──────────────────────────────────────────────────
# `curl … | sh` 라 이 스크립트의 stdin 은 **파이프**다. 그래서 /dev/tty(제어 단말)를 직접 물려 준다 —
#  이것 하나로 "복사 1번 → 가림 입력 → 설치 완료"가 한 창에서 끝난다(토큰은 어디에도 안 남는다).
if [ -r /dev/tty ] && [ -t 1 ]; then
  exec "$LIVELY_DIR/bin/lively" setup < /dev/tty
fi

# 비대화형(CI·원격 스크립트) — 사람이 없으니 다음 할 일만 알려 준다.
say ""
ok "lively CLI 준비 완료."
say ""
say "  다음 두 명령을 실행하세요:"
say ""
say "      lively login      # 접속 토큰 입력(화면에 안 보임)"
say "      lively install    # 키트 설치"
say ""
say "  (지금 창에서 'lively: command not found' 가 나면 새 터미널을 열거나  source ~/.zshrc)"
say ""
