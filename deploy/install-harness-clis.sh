#!/usr/bin/env bash
set -euo pipefail
# ─────────────────────────────────────────────────────────────────────────────
# 셀프호스트 박스에 제미나이(Antigravity `agy`)·그록(Grok Build `grok`) CLI 를 박스 전체(/usr/local/bin)에 설치 (#4970).
#
#  왜: 서버에서 띄울 수 있는 AI 넷(클로드·챗GPT·제미나이·그록) 가운데 셀프호스트 설치 과정은 클로드(서비스 유저 · 격리면 구성원마다)와
#   챗GPT(격리 구성원마다 — install-codex-user)만 깔았다. 제미나이·그록은 셀프호스트 어디에도 설치 단계가 없어, 처음 설정 «AI 연결» 이
#   그 둘을 «이 서버에 없음» 으로 숨겼다(위시스트 실측 2026-10-23). 매니지드는 세션 이미지가 넷을 다 싣는다(lvly-cloud
#   tenant-image/Dockerfile #1879) — 이 스크립트는 그 이미지와 같은 실행 파일을 셀프호스트 박스에 둔다.
#
#  자리: 둘 다 **박스 전체**(/usr/local/bin, root 0755). 세션은 서비스 유저나 box_<멤버> uid 로 도니 자기 자신을 덮어쓰지 못한다
#   (매니지드와 같은 구조 — 갱신은 이 스크립트를 FORCE=1 로 다시 돌린다). 자격(로그인)은 각자 홈(~/.gemini · ~/.grok)이라 격리 박스면
#   구성원마다 따로다.
#
#  ★ 벤더 설치기를 root 로 돌리지 않는다(격리 리뷰 2026-10-23 실측). grok 설치기는 PATH 에 있고 쓸 수 있는 폴더에 `grok`·`agent` 심링크를
#   **`ln -sf` 로 무조건** 건다 — root 로 돌리면 남의 /usr/local/bin/agent 를 덮고, 뒤에서 그 링크를 걷으면 원래 것이 사라진다. 그래서:
#   · 설치기는 **권한 없는 계정**(nobody)으로, **임시 HOME** 에서, 설치 자리를 뺀 PATH(/usr/bin:/bin)로 돌린다 → 박스에 아무것도 못 쓴다.
#   · 설치기 파일은 먼저 받아 두고(시간 상한) 다 받은 뒤에 돌린다 — 끊긴 스크립트가 부분 실행되지 않게.
#   · 그래도 설치 자리의 grok·agent 가 바뀌었으면 원래대로 되돌린다(안전망 — 시험 H2).
#   · 실체 파일만 root 가 설치 자리로 옮긴다(같은 폴더의 임시 이름에 쓴 뒤 mv — 도는 중에 잘린 파일을 보지 않게).
#  멱등: 이미 돌면 스킵(권한 없는 계정으로 재 본다 — root 만 닿는 /root 밑 링크를 «있음» 으로 치지 않게) · FORCE=1 이면 다시 받는다 ·
#   OFFLINE=1 이면 아무것도 안 한다. 실패하면 그 자리에서 멈춘다 — 호출부에 `||` 를 달지 않는다(달면 함수 안에서 set -e 가 꺼져, 실패한
#   설치 뒤에 «✓» 를 찍고 0 으로 끝났다 — 격리 리뷰). 위험한 명령은 `|| return 1` 로 따로 묶는다(명령 치환 안에서도 멈추게).
#  버전 핀 없음 — 두 설치기 모두 버전 인자를 공개하지 않는다(Dockerfile 머리말). 받는 시점의 최신 안정판.
#
# 사용: sudo bash deploy/install-harness-clis.sh [agy] [grok]     (인자 없으면 둘 다)
#   LVLY_HARNESS_BIN_DIR — 설치 자리를 바꾼다(시험용 · 그때만 root 가 아니어도 된다 · 그때는 설치기를 지금 계정으로 돌린다). 기본 /usr/local/bin.
# ─────────────────────────────────────────────────────────────────────────────
BIN_DIR="${LVLY_HARNESS_BIN_DIR:-/usr/local/bin}"
IS_ROOT=0; [ "$(id -u)" -eq 0 ] && IS_ROOT=1
[ "$IS_ROOT" = 1 ] || [ -n "${LVLY_HARNESS_BIN_DIR:-}" ] || { echo "root 로 실행하세요: sudo bash $0 [agy] [grok]" >&2; exit 1; }
[ "${OFFLINE:-0}" = 1 ] && { echo "OFFLINE=1 — 제미나이·그록 설치를 건너뜁니다"; exit 0; }
command -v curl >/dev/null 2>&1 || { echo "curl 이 없습니다" >&2; exit 1; }
[ -d "$BIN_DIR" ] || { echo "설치 자리가 없습니다: $BIN_DIR" >&2; exit 1; }
if [ "$IS_ROOT" = 1 ]; then
  command -v runuser >/dev/null 2>&1 || { echo "runuser 가 없습니다 — 설치기를 권한 없는 계정으로 돌릴 수 없어 멈춥니다" >&2; exit 1; }
  id nobody >/dev/null 2>&1 || { echo "nobody 계정이 없습니다" >&2; exit 1; }
fi
OWN=(); [ "$IS_ROOT" = 1 ] && OWN=(-o root -g root)

WANT=("$@"); [ "${#WANT[@]}" -gt 0 ] || WANT=(agy grok)

# 임시 자리는 끝날 때(실패·중단 포함) 다 치운다.
TMPS=()
cleanup() { local d; for d in ${TMPS[@]+"${TMPS[@]}"}; do [ -n "$d" ] && rm -rf "$d"; done; }
trap cleanup EXIT INT TERM

# 권한 없는 계정으로(시험 자리면 지금 계정으로) 명령을 돌린다 — 설치기·«이미 있나» 확인이 쓴다.
as_plain() {
  if [ "$IS_ROOT" = 1 ]; then runuser -u nobody -- "$@"; else "$@"; fi
}

# 이미 돌면 스킵 — 설치기를 매번 받지 않는다. root 가 아니라 권한 없는 계정이 돌 수 있어야 «있음» 이다.
present() { [ "${FORCE:-0}" != 1 ] && [ -x "$BIN_DIR/$1" ] && as_plain "$BIN_DIR/$1" --version >/dev/null 2>&1 </dev/null; }

# (안전망) 설치 자리의 이름 하나가 지금 무엇인지 — 링크면 가리키는 곳, 파일이면 내용 지문, 없으면 «-».
ident() {
  local p="$1"
  if [ -L "$p" ]; then printf 'L:%s' "$(readlink "$p")"
  elif [ -e "$p" ]; then printf 'F:%s' "$(cksum < "$p")"
  else printf '-'; fi
}

# 임시 폴더 하나 — 실패하면 빈 이름으로 나아가지 않는다(빈 이름이면 HOME="" 설치 · 걷기 대상이 «/» 밑 전부가 된다 — 격리 리뷰).
fresh_dir() {
  local d
  d="$(mktemp -d)" || return 1
  [ -n "$d" ] && [ -d "$d" ] || { echo "임시 폴더를 만들지 못했습니다" >&2; return 1; }
  printf '%s' "$d"
}

install_one() {
  local name="$1" url="$2" rel="$3"
  if present "$name"; then echo "  ✓ $name 이미 있음 — $(as_plain "$BIN_DIR/$name" --version 2>/dev/null </dev/null | head -1)"; return 0; fi
  local H backup n i before=()
  H="$(fresh_dir)" || return 1; TMPS+=("$H")
  backup="$(fresh_dir)" || return 1; TMPS+=("$backup")
  #  안전망 기록: 설치 자리의 grok·agent 가 지금 무엇인지(권한 없는 계정 · 좁힌 PATH 라 원래 못 건드린다).
  for n in grok agent; do
    before+=("$(ident "$BIN_DIR/$n")")
    if [ -e "$BIN_DIR/$n" ] || [ -L "$BIN_DIR/$n" ]; then cp -P "$BIN_DIR/$n" "$backup/$n" || return 1; fi
  done
  #  설치기는 먼저 다 받아 둔다(상한 120초) — 끊긴 스크립트를 돌리지 않는다.
  curl -fsSL --max-time 120 -o "$H/install.sh" "$url" || { echo "  ✗ $name 설치기를 받지 못했습니다: $url" >&2; return 1; }
  if [ "$IS_ROOT" = 1 ]; then chown -R nobody "$H" || return 1; fi
  #  ⚠ env -i 로 비우지 않는다 — 설치기가 USER·LANG 같은 값을 set -u 로 읽다 죽을 수 있다. 바꾸는 것은 HOME·PATH·TMPDIR 셋.
  as_plain env HOME="$H" PATH=/usr/bin:/bin TMPDIR="$H" bash "$H/install.sh" >/dev/null || { echo "  ✗ $name 설치기가 실패했습니다" >&2; return 1; }
  #  안전망: 설치기가 설치 자리를 건드렸으면 원래대로(없던 것은 걷고, 있던 것은 되돌린다).
  i=0
  for n in grok agent; do
    if [ "$(ident "$BIN_DIR/$n")" != "${before[$i]}" ]; then
      rm -f "$BIN_DIR/$n" || return 1
      if [ -e "$backup/$n" ] || [ -L "$backup/$n" ]; then mv -f "$backup/$n" "$BIN_DIR/$n" || return 1; fi
      echo "  ! 설치기가 $BIN_DIR/$n 을 건드려 원래대로 되돌렸습니다" >&2
    fi
    i=$((i + 1))
  done
  #  실체를 설치 자리로 — 같은 폴더의 임시 이름에 쓴 뒤 mv.
  local real
  real="$(readlink -f "$H/$rel" 2>/dev/null || true)"
  [ -n "$real" ] && [ -f "$real" ] && [ -x "$real" ] || { echo "  ✗ $name 설치기가 실행 파일을 남기지 않았습니다($rel)" >&2; return 1; }
  install -m 0755 ${OWN[@]+"${OWN[@]}"} "$real" "$BIN_DIR/.$name.new" || return 1
  mv -f "$BIN_DIR/.$name.new" "$BIN_DIR/$name" || return 1
  as_plain "$BIN_DIR/$name" --version >/dev/null 2>&1 </dev/null || { echo "  ✗ $name 가 설치 자리에서 돌지 않습니다" >&2; return 1; }
  echo "  ✓ $name → $BIN_DIR/$name — $(as_plain "$BIN_DIR/$name" --version 2>/dev/null </dev/null | head -1)"
}

for h in "${WANT[@]}"; do
  case "$h" in
    agy|antigravity|gemini) install_one agy https://antigravity.google/cli/install.sh .local/bin/agy ;;
    grok) install_one grok https://x.ai/cli/install.sh .grok/bin/grok ;;
    *) echo "  ? 모르는 하네스: $h (agy · grok)" >&2; exit 1 ;;
  esac
done
