#!/usr/bin/env bash
set -euo pipefail
# ─────────────────────────────────────────────────────────────────────────────
# 멤버(OS 유저) 홈에 Codex CLI 설치 + npm 전역 prefix 를 멤버 홈으로 — 자동 업데이트 EACCES 근절.
#
#  왜: codex 는 시작할 때 스스로 최신을 확인하고 `npm install -g @openai/codex` 를 실행한다(rust 바이너리
#   내장 동작 — 끄는 플래그가 없다). 박스의 codex 가 root 전역(/usr/lib/node_modules)에 깔려 있으면
#   비-root 멤버는 거기 못 써서 그 업데이트가 EACCES 로 죽고, **codex 가 로그인 화면도 못 띄운 채 즉시
#   종료**된다(실측 2026-08-27: exit status 243. 라이블리 안내는 '로그인 만료'를 먼저 말해 오진을 유도한다).
#   claude 는 같은 문제를 네이티브 self-update 설치로 이미 풀었다(#1023, install-claude-user.sh) — 이건
#   그 codex 판이다. 다만 codex 는 네이티브 설치기가 없어 npm 경로를 쓴다.
#
#  그래서 두 가지를 한다:
#   ① `~/.npmrc` 의 prefix 를 `$HOME/.npm-global` 로 — codex 의 자동 업데이트가 **자기 홈**에 쓰므로 성공한다.
#      이 경로는 box-spawn 이 PATH 에 이미 넣어둔 자리다(box-spawn 머리주석 "~/.npm-global/bin — 멤버 npm 전역").
#      자리는 예약돼 있었는데 prefix 를 그 값으로 설정하는 코드가 없어 npm prefix 가 /usr 로 남아 있었다.
#   ② 그 prefix 로 codex 를 1회 설치 — 이후는 codex 가 스스로 최신화한다(claude 와 같은 그림).
#
#  멱등·비파괴·best-effort:
#   - 이미 `~/.npm-global/bin/codex` 있으면 스킵 — 그 뒤론 codex 자동 업데이터가 알아서 최신화.
#     → refresh-member-kits.sh 가 매 update.sh 마다 전 멤버에 호출해도 첫 부트스트랩 1회만 설치한다.
#   - `~/.npmrc` 에 이미 prefix 가 있으면 **그 값을 존중**하고 손대지 않는다(멤버가 의도한 설정일 수 있다).
#     그 경우에도 설치는 그 prefix 로 진행되므로, 멤버가 쓰기 가능한 곳을 골랐다면 목적은 달성된다.
#   - OFFLINE(에어갭)/네트워크 불가면 스킵 — 그 박스는 어차피 자동업뎃 불가(사전설치 가정).
#   - 실패해도 exit 0 — 프로비저닝/업뎃을 막지 않는다. 폴백은 시스템 codex(= 종전 동작, 무회귀).
#
# 사용: sudo bash install-codex-user.sh <osuser>   (root → 내부에서 runuser 로 그 유저 uid 로 설치)
#   버전 고정이 필요하면 CODEX_NPM_SPEC(기본 @openai/codex = latest)로 `@openai/codex@0.149.1` 등 지정.
# ─────────────────────────────────────────────────────────────────────────────
U="${1:-}"; [ -n "$U" ] || { echo "사용: sudo bash $0 <osuser>"; exit 0; }
# ⚠ 로그 규약(install-claude-user 와 동일): **멱등 스킵 경로는 조용히**(무출력). 매 update.sh 마다 전 멤버가
#  '이미 설치됨'을 찍으면 노이즈다. 실제 '설치 액션'과 '실패'만 한 줄씩 낸다.
id "$U" >/dev/null 2>&1 || exit 0                                    # 유저 없음(그룹 잔재 등) → 조용히 스킵
H="$(getent passwd "$U" | cut -d: -f6 || true)"
[ -n "$H" ] && [ -d "$H" ] || exit 0                                 # 홈 없음 → 조용히 스킵
command -v npm >/dev/null 2>&1 || exit 0                             # npm 없는 박스 → 조용히 스킵(폴백=시스템 codex)

PREFIX_DIR="$H/.npm-global"

# ── ① npm prefix 보정 — **바이너리 존재 확인보다 앞**에 둔다. ────────────────────
#  왜 앞인가: `~/.npm-global/bin/codex` 는 있는데 npmrc 에 prefix 가 없는 부분 상태(수동 설치, 혹은 멤버가
#  npmrc 를 정리)가 가능하다. 스킵이 먼저면 그 상태가 **영구 고착**돼 자동 업데이트가 계속 EACCES 로 죽는다.
#  보정을 앞에 두면 grep 1회 비용으로 불변식이 자가치유된다.
#  이미 prefix 가 있으면 존중(비파괴) — 멤버가 의도한 설정일 수 있다. npmrc 는 사용자 파일이라 통째로 쓰지
#  않고 prefix 키가 없을 때만 센티넬 주석과 함께 append 한다(leading \n 으로 시작해, 기존 파일 마지막 줄에
#  개행이 없어도 직전 설정에 이어붙지 않는다).
if [ "${OFFLINE:-0}" != "1" ] \
   && ! runuser -u "$U" -- env HOME="$H" grep -qE '^[[:space:]]*prefix[[:space:]]*=' "$H/.npmrc" 2>/dev/null; then
  runuser -u "$U" -- env HOME="$H" PREFIX_DIR="$PREFIX_DIR" bash -c \
    'printf "\n# lively: codex 자동 업데이트(npm install -g)가 멤버 홈에 쓰도록 — /usr 전역은 EACCES\nprefix=%s\n" "$PREFIX_DIR" >> "$HOME/.npmrc"' \
    2>/dev/null || echo "  ⚠ $U — ~/.npmrc prefix 설정 실패 — codex 자동 업뎃은 계속 EACCES 일 수 있음"
fi

# ── ② 실효 prefix 기준으로 판정한다 — 고정 경로로 판정하면 커스텀 prefix 멤버에서 어긋난다. ──
#  (고정 판정이면: 설치는 커스텀 prefix 로 가는데 판정은 ~/.npm-global 을 봐 ①성공에도 실패 로그 ②매
#   update.sh 마다 수백MB 재설치 반복 ③box-spawn PATH 에 없는 자리라 증상 미해소 — 세 가지가 한꺼번에 난다.)
EFF_PREFIX="$(runuser -u "$U" -- env HOME="$H" npm config get prefix 2>/dev/null | tr -d '\r' | tail -1)"
[ -n "$EFF_PREFIX" ] || EFF_PREFIX="$PREFIX_DIR"
CODEX_BIN="$EFF_PREFIX/bin/codex"

# 이미 멤버 소유 codex 가 있으면 재설치 불필요 — codex 자동 업데이터가 최신화 → 조용히 스킵.
#  (root 는 700 홈 DAC 를 우회하므로 '읽기'는 직접 가능. '쓰기'만 멤버 uid(runuser)로 한다.)
[ -x "$CODEX_BIN" ] && exit 0

# 에어갭/오프라인이면 스킵(npm registry 접근 필요) → 조용히 스킵.
[ "${OFFLINE:-0}" = "1" ] && exit 0

# ── ③ 설치(멤버 uid·비대화형). 성공 판정은 실효 prefix 의 실제 바이너리 존재로. ──
SPEC="${CODEX_NPM_SPEC:-@openai/codex}"
if runuser -u "$U" -- env HOME="$H" PATH="$EFF_PREFIX/bin:$PATH" \
     npm install -g --no-fund --no-audit "$SPEC" >/dev/null 2>&1 \
   && [ -x "$CODEX_BIN" ]; then
  # prefix 가 홈 밖이면 box-spawn PATH(~/.local/bin:~/.npm-global/bin:…)에 없어 세션이 여전히 시스템
  #  codex 를 쓴다 → 증상이 남는다. 설치는 성공했으니 실패로 보고하지 않고 그 사실만 정확히 알린다.
  case "$CODEX_BIN" in
    "$H"/*) echo "  ✓ $U — 멤버 홈 codex 설치($CODEX_BIN · 이후 자동 업뎃)" ;;
    *) echo "  ⚠ $U — codex 를 홈 밖 prefix 에 설치($CODEX_BIN) — box-spawn PATH 에 없어 세션은 시스템 codex 를 쓴다(증상 잔존). ~/.npmrc 의 prefix 를 홈 아래로 두세요" ;;
  esac
else
  echo "  ⚠ $U — 멤버 홈 codex 설치 실패(네트워크?) — 폴백=시스템 codex(자동 업뎃 EACCES 로 세션 즉시 종료 가능), 다음 업뎃에 재시도"
fi
exit 0
