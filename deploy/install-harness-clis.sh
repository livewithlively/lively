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
# 요구: root · runuser(util-linux) · nobody 계정 · curl · 실행 가능한 임시 자리(/tmp 가 noexec 면 TMPDIR=/var/tmp 로).
# 사용: sudo bash deploy/install-harness-clis.sh [agy] [grok]     (인자 없으면 둘 다)
#   LVLY_HARNESS_BIN_DIR — 설치 자리를 바꾼다(시험용 · 그때만 root 가 아니어도 된다 · 그때는 설치기를 지금 계정으로 돌린다). 기본 /usr/local/bin.
# ─────────────────────────────────────────────────────────────────────────────
BIN_DIR="${LVLY_HARNESS_BIN_DIR:-/usr/local/bin}"
IS_ROOT=0; [ "$(id -u)" -eq 0 ] && IS_ROOT=1
[ "$IS_ROOT" = 1 ] || [ -n "${LVLY_HARNESS_BIN_DIR:-}" ] || { echo "root 로 실행하세요: sudo bash $0 [agy] [grok]" >&2; exit 1; }
[ "${OFFLINE:-0}" = 1 ] && { echo "OFFLINE=1 — 제미나이·그록 설치를 건너뜁니다"; exit 0; }
PATH="$PATH:/usr/sbin:/sbin"   # runuser 는 sbin 에 있다 — 부른 쪽 PATH 에 기대지 않는다
command -v curl >/dev/null 2>&1 || { echo "curl 이 없습니다" >&2; exit 1; }
[ -d "$BIN_DIR" ] || { echo "설치 자리가 없습니다: $BIN_DIR" >&2; exit 1; }
BIN_DIR="$(cd "$BIN_DIR" && pwd)"   # 상대 경로(시험 자리)는 아래 cd / 뒤에 엉뚱한 곳이 된다 — 지금 절대 경로로
if [ "$IS_ROOT" = 1 ]; then
  command -v runuser >/dev/null 2>&1 || { echo "runuser 가 없습니다 — 설치기를 권한 없는 계정으로 돌릴 수 없어 멈춥니다" >&2; exit 1; }
  id nobody >/dev/null 2>&1 || { echo "nobody 계정이 없습니다" >&2; exit 1; }
fi
OWN=(); [ "$IS_ROOT" = 1 ] && OWN=(-o root -g root)

WANT=("$@"); [ "${#WANT[@]}" -gt 0 ] || WANT=(agy grok)
#  권한 없는 계정이 못 들어가는 자리(sudo 를 부른 /root · 0750 홈)에서 시작해도 되게 — 이 스크립트는 절대 경로만 쓴다.
cd /

# 끝날 때(실패·중단 포함) 다 치운다 — 임시 폴더 · 설치 자리에 쓰다 만 임시 이름. 중단이면 그 신호의 종료코드로 끝낸다(뒤 본문을 잇지 않게).
TMPS=(); PARTS=()
cleanup() {
  local d
  for d in ${TMPS[@]+"${TMPS[@]}"}; do [ -n "$d" ] && rm -rf "$d"; done
  for d in ${PARTS[@]+"${PARTS[@]}"}; do [ -n "$d" ] && rm -f "$d"; done
  return 0
}
trap cleanup EXIT
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

# 임시 폴더 하나 — 실패하면 빈 이름으로 나아가지 않는다(빈 이름이면 HOME="" 설치 · 걷기 대상이 «/» 밑 전부가 된다 — 격리 리뷰).
fresh_dir() {
  local d
  d="$(mktemp -d)" || return 1
  [ -n "$d" ] && [ -d "$d" ] || { echo "임시 폴더를 만들지 못했습니다" >&2; return 1; }
  printf '%s' "$d"
}
# 권한 없는 계정이 쓸 임시 폴더(설치기 HOME · 버전 확인 HOME). ⚠ 되돌림용 백업 폴더는 이걸 쓰지 않는다 — root 몫으로 둔다
#  (설치기가 그 계정으로 도니, 그 계정 몫이면 백업을 바꿔 칠 수 있다).
plain_dir() {
  local d
  d="$(fresh_dir)" || return 1
  if [ "$IS_ROOT" = 1 ]; then chown nobody "$d" || { rm -rf "$d"; return 1; }; fi
  printf '%s' "$d"
}

# 권한 없는 계정으로(시험 자리면 지금 계정으로) 명령을 돌린다 — 설치기·«이미 있나» 확인이 쓴다.
as_plain() {
  if [ "$IS_ROOT" = 1 ]; then runuser -u nobody -- "$@"; else "$@"; fi
}

# 버전 확인 — 권한 없는 계정 · 버리는 HOME 으로(HOME 이 /root 면 --version 이 설정 폴더를 만들다 죽는 CLI 가 있다).
PROBE_HOME="$(plain_dir)" || exit 1
TMPS+=("$PROBE_HOME")
version_of() { as_plain env HOME="$PROBE_HOME" "$BIN_DIR/$1" --version 2>/dev/null </dev/null | head -1; }
runs() { as_plain env HOME="$PROBE_HOME" "$BIN_DIR/$1" --version >/dev/null 2>&1 </dev/null; }

# 이미 돌면 스킵 — 설치기를 매번 받지 않는다. root 가 아니라 권한 없는 계정이 돌 수 있어야 «있음» 이다.
present() { [ "${FORCE:-0}" != 1 ] && [ -x "$BIN_DIR/$1" ] && runs "$1"; }

# (안전망) 설치 자리의 이름 하나가 지금 무엇인지 — 링크면 가리키는 곳, 파일이면 내용 지문, 없으면 «-».
ident() {
  local p="$1"
  if [ -L "$p" ]; then printf 'L:%s' "$(readlink "$p")"
  elif [ -e "$p" ]; then printf 'F:%s' "$(cksum < "$p")"
  else printf '-'; fi
}

install_one() {
  local name="$1" url="$2" rel="$3"
  if present "$name"; then echo "  ✓ $name 이미 있음 — $(version_of "$name")"; return 0; fi
  local H Hr backup n i rc before=()
  H="$(plain_dir)" || return 1; TMPS+=("$H")
  Hr="$(cd "$H" && pwd -P)" || return 1   # 맥 /var → /private/var — 아래 «HOME 안인가» 비교는 풀린 경로끼리
  backup="$(fresh_dir)" || return 1; TMPS+=("$backup")
  #  안전망 기록: 설치 자리의 grok·agent 가 지금 무엇인지(권한 없는 계정 · 좁힌 PATH 라 원래 못 건드린다).
  #   백업은 하드 링크(같은 inode — 모드·소유 그대로 · 165MB grok 을 복사하지 않는다), 다른 파일시스템이면 모드·소유를 지켜 복사.
  for n in grok agent; do
    before+=("$(ident "$BIN_DIR/$n")")
    if [ -e "$BIN_DIR/$n" ] || [ -L "$BIN_DIR/$n" ]; then
      ln -P "$BIN_DIR/$n" "$backup/$n" 2>/dev/null || cp -pP "$BIN_DIR/$n" "$backup/$n" || return 1
    fi
  done
  #  설치기는 먼저 다 받아 둔다(상한 120초) — 끊긴 스크립트를 돌리지 않는다.
  curl -fsSL --max-time 120 -o "$H/install.sh" "$url" || { echo "  ✗ $name 설치기를 받지 못했습니다: $url" >&2; return 1; }
  if [ "$IS_ROOT" = 1 ]; then chown -R nobody "$H" || return 1; fi
  #  ⚠ env -i 로 비우지 않는다 — 설치기가 USER·LANG 같은 값을 set -u 로 읽다 죽을 수 있다. 바꾸는 것은 HOME·PATH·TMPDIR 셋.
  #   그 HOME 안에서 돈다(받은 파일을 지금 폴더에 쓰는 설치기가 있다 — 지금 폴더는 «/» 다). 출력은 받아 두고 실패할 때만 보인다
  #   (성공해도 «Add <곧 지워질 임시 경로> to your PATH» 같은 안내를 찍어 운영자를 헷갈리게 한다).
  rc=0
  ( cd "$H" && as_plain env HOME="$H" PATH=/usr/bin:/bin TMPDIR="$H" bash "$H/install.sh" ) > "$H/.install.log" 2>&1 < /dev/null || rc=$?
  #  안전망: 설치기가 설치 자리를 건드렸으면 원래대로(없던 것은 걷고, 있던 것은 되돌린다) — 설치기가 실패했어도 먼저 한다.
  i=0
  for n in grok agent; do
    if [ "$(ident "$BIN_DIR/$n")" != "${before[$i]}" ]; then
      rm -f "$BIN_DIR/$n" || return 1
      if [ -e "$backup/$n" ] || [ -L "$backup/$n" ]; then mv -f "$backup/$n" "$BIN_DIR/$n" || return 1; fi
      echo "  ! 설치기가 $BIN_DIR/$n 을 건드려 원래대로 되돌렸습니다" >&2
    fi
    i=$((i + 1))
  done
  if [ "$rc" != 0 ]; then
    echo "  ✗ $name 설치기가 실패했습니다(종료 $rc) — 설치기 출력 끝:" >&2
    tail -n 15 "$H/.install.log" | sed 's/^/      /' >&2
    return 1
  fi
  #  실체를 설치 자리로 — 그 HOME 안의 실행 파일만(권한 없는 계정 몫 폴더의 링크를 root 가 밖으로 따라가지 않는다), 같은 폴더의 임시
  #   이름에 쓴 뒤 mv(도는 중에 잘린 파일을 보지 않게 · 쓰다 실패하면 옛 파일이 그대로 · 쓰다 만 임시 이름은 끝날 때 지운다).
  local real
  real="$(readlink -f "$H/$rel" 2>/dev/null || true)"
  case "$real" in
    "$Hr"/*) ;;
    *) echo "  ✗ $name 실행 파일이 설치기 자리 밖을 가리킵니다(${real:-없음}) — 설치하지 않습니다" >&2; return 1 ;;
  esac
  [ -f "$real" ] || { echo "  ✗ $name 설치기가 실행 파일을 남기지 않았습니다($rel)" >&2; return 1; }
  [ -x "$real" ] || { echo "  ✗ $name 실행 파일에 실행 권한이 없습니다($rel) — 임시 자리가 noexec 면 TMPDIR=/var/tmp 로 다시 돌려 보세요" >&2; return 1; }
  PARTS+=("$BIN_DIR/.$name.new")
  install -m 0755 ${OWN[@]+"${OWN[@]}"} "$real" "$BIN_DIR/.$name.new" || return 1
  mv -f "$BIN_DIR/.$name.new" "$BIN_DIR/$name" || return 1
  runs "$name" || { echo "  ✗ $name 가 설치 자리에서 돌지 않습니다(권한 없는 계정으로)" >&2; return 1; }
  echo "  ✓ $name → $BIN_DIR/$name — $(version_of "$name")"
}

for h in "${WANT[@]}"; do
  case "$h" in
    agy|antigravity|gemini) install_one agy https://antigravity.google/cli/install.sh .local/bin/agy ;;
    grok) install_one grok https://x.ai/cli/install.sh .grok/bin/grok ;;
    *) echo "  ? 모르는 하네스: $h (agy · grok)" >&2; exit 1 ;;
  esac
done
