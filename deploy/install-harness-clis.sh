#!/usr/bin/env bash
set -euo pipefail
# ─────────────────────────────────────────────────────────────────────────────
# 셀프호스트 박스에 제미나이(Antigravity `agy`)·그록(Grok Build `grok`) CLI 를 박스 전체(/usr/local/bin)에 설치 (#4970).
#
#  왜: 서버에서 띄울 수 있는 AI 넷(클로드·챗GPT·제미나이·그록) 가운데 셀프호스트 설치 과정은 클로드(서비스 유저 · 격리면 구성원마다)와
#   챗GPT(격리 구성원마다 — install-codex-user)만 깔았다. 제미나이·그록은 셀프호스트 어디에도 설치 단계가 없어, 처음 설정 «AI 연결» 이
#   그 둘을 «이 서버에 없음» 으로 숨겼다(위시스트 실측 2026-10-23). 매니지드는 세션 이미지가 넷을 다 싣는다(lvly-cloud
#   tenant-image/Dockerfile #1879) — 이 스크립트는 **그 이미지와 같은 설치**를 셀프호스트 박스에 한다.
#
#  자리: 둘 다 **박스 전체**(/usr/local/bin, root:root 0755). 세션은 서비스 유저나 box_<멤버> uid 로 도니 자기 자신을 덮어쓰지 못한다
#   (매니지드와 같은 구조 — 자가 갱신은 이 스크립트를 FORCE=1 로 다시 돌린다). 자격(로그인)은 각자 홈(~/.gemini · ~/.grok)이라
#   격리 박스면 구성원마다 따로다.
#  설치기는 **임시 HOME** 에서 돌린다 — root 홈을 어지르지 않고, 설치기가 남긴 것은 실체만 옮긴 뒤 통째로 지운다.
#   ⚠ grok 설치기는 `/usr/local/bin/{grok,agent}` 에 자기 홈을 가리키는 **심링크**를 건다(Dockerfile 머리말 실측). 임시 HOME 을 지우면
#    그 링크가 끊기므로 먼저 걷는다 — 단 **그 임시 HOME 을 가리키는 링크만** 걷는다(남의 `agent` 를 지우지 않는다).
#  멱등: 이미 /usr/local/bin/<bin> 이 돌면 스킵(FORCE=1 이면 다시 받는다). OFFLINE=1 이면 아무것도 안 한다.
#  버전 핀 없음 — 두 설치기 모두 버전 인자를 공개하지 않는다(Dockerfile 머리말). 받는 시점의 최신 안정판.
#
# 사용: sudo bash deploy/install-harness-clis.sh [agy] [grok]     (인자 없으면 둘 다)
#   LVLY_HARNESS_BIN_DIR — 설치 자리를 바꾼다(시험용 · 그때만 root 가 아니어도 된다). 기본 /usr/local/bin.
# ─────────────────────────────────────────────────────────────────────────────
BIN_DIR="${LVLY_HARNESS_BIN_DIR:-/usr/local/bin}"
[ "$(id -u)" -eq 0 ] || [ -n "${LVLY_HARNESS_BIN_DIR:-}" ] || { echo "root 로 실행하세요: sudo bash $0 [agy] [grok]" >&2; exit 1; }
OWN=(); [ "$(id -u)" -eq 0 ] && OWN=(-o root -g root)
[ "${OFFLINE:-0}" = 1 ] && { echo "OFFLINE=1 — 제미나이·그록 설치를 건너뜁니다"; exit 0; }
command -v curl >/dev/null 2>&1 || { echo "curl 이 없습니다" >&2; exit 1; }

WANT=("$@"); [ "${#WANT[@]}" -gt 0 ] || WANT=(agy grok)

# 이미 돌면 스킵 — 설치기를 매번 받지 않는다.
present() { [ "${FORCE:-0}" != 1 ] && [ -x "$BIN_DIR/$1" ] && "$BIN_DIR/$1" --version >/dev/null 2>&1 </dev/null; }

install_agy() {
  if present agy; then echo "  ✓ agy 이미 있음 — $("$BIN_DIR/agy" --version 2>/dev/null </dev/null | head -1)"; return 0; fi
  local H; H="$(mktemp -d)"
  HOME="$H" bash -c 'curl -fsSL https://antigravity.google/cli/install.sh | bash' >/dev/null
  local real; real="$(readlink -f "$H/.local/bin/agy" 2>/dev/null || true)"
  [ -n "$real" ] && [ -x "$real" ] || { rm -rf "$H"; echo "  ✗ agy 설치기가 실행 파일을 남기지 않았습니다($H/.local/bin/agy)" >&2; return 1; }
  install -m 0755 ${OWN[@]+"${OWN[@]}"} "$real" "$BIN_DIR/agy"
  rm -rf "$H"
  echo "  ✓ agy → $BIN_DIR/agy — $("$BIN_DIR/agy" --version 2>/dev/null </dev/null | head -1)"
}

install_grok() {
  if present grok; then echo "  ✓ grok 이미 있음 — $("$BIN_DIR/grok" --version 2>/dev/null </dev/null | head -1)"; return 0; fi
  local H; H="$(mktemp -d)"
  HOME="$H" bash -c 'curl -fsSL https://x.ai/cli/install.sh | bash' >/dev/null
  local real; real="$(readlink -f "$H/.grok/bin/grok" 2>/dev/null || true)"
  [ -n "$real" ] && [ -x "$real" ] || { rm -rf "$H"; echo "  ✗ grok 설치기가 실행 파일을 남기지 않았습니다($H/.grok/bin/grok)" >&2; return 1; }
  local tmpbin; tmpbin="$(mktemp)"
  cp "$real" "$tmpbin"
  # 설치기가 건 심링크 중 **이 임시 HOME 을 가리키는 것만** 걷는다(남이 둔 grok·agent 는 손대지 않는다).
  #  ⚠ 비교는 **풀어 쓴 경로**끼리 한다 — 임시 폴더가 심링크 밑이면(맥 /var → /private/var) `readlink -f` 는 풀린 경로를 주는데
  #   $H 는 안 풀린 채라 맞춰 보지 못하고 링크를 남겼다(시험 H1 이 잡았다). 링크 글자 그대로(readlink)도 함께 본다.
  local Hr; Hr="$(cd "$H" && pwd -P)"
  for l in "$BIN_DIR/grok" "$BIN_DIR/agent"; do
    if [ -L "$l" ]; then
      for tgt in "$(readlink -f "$l" 2>/dev/null || true)" "$(readlink "$l" 2>/dev/null || true)"; do
        case "$tgt" in "$H"/*|"$Hr"/*) rm -f "$l"; break ;; esac
      done
    fi
  done
  install -m 0755 ${OWN[@]+"${OWN[@]}"} "$tmpbin" "$BIN_DIR/grok"
  rm -rf "$tmpbin" "$H"
  echo "  ✓ grok → $BIN_DIR/grok — $("$BIN_DIR/grok" --version 2>/dev/null </dev/null | head -1)"
}

rc=0
for h in "${WANT[@]}"; do
  case "$h" in
    agy|antigravity|gemini) install_agy || rc=1 ;;
    grok) install_grok || rc=1 ;;
    *) echo "  ? 모르는 하네스: $h (agy · grok)" >&2; rc=1 ;;
  esac
done
exit "$rc"
