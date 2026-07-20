#!/usr/bin/env bash
set -euo pipefail
# ─────────────────────────────────────────────────────────────────────────────
# 멤버(OS 유저) 홈에 Claude Code **네이티브** 설치 — 자동 업데이트 no_permissions 근절(#1023).
#
#  왜: 박스에 claude 가 root 전역(sudo npm i -g → /usr/lib/node_modules)으로 깔리면 비-root 멤버가
#   /usr/lib 에 못 써서 claude 자동 업뎃이 no_permissions 로 실패한다(.last-update-result.json:
#   {"outcome":"failed","status":"no_permissions",...}). 맥미니는 사용자 홈 설치라 잘 되는 것과 대조 —
#   차이는 OS 가 아니라 설치 위치의 쓰기 권한. 네이티브 설치기는 멤버 700 홈(~/.local)에 self-update
#   standalone 바이너리를 깐다 → 멤버가 자기 uid 로 스스로 최신화(맥미니와 동일). box-spawn PATH 가
#   ~/.local/bin 을 /usr/bin 보다 **먼저** 둬서(멤버 소유 claude 우선) 스테일 시스템 claude 를 가린다.
#   근거(Anthropic 공식 setup 문서): 네이티브 = 권장 경로, npm 전역은 prefix 가 사용자쓰기 가능해야만 자동업뎃.
#
#  멱등·비파괴·best-effort:
#   - 이미 ~/.local/bin/claude 있으면 스킵 — 그 뒤론 네이티브 updater 가 알아서 최신화(재다운로드 안 함).
#     → refresh-member-kits.sh 가 매 update.sh 마다 전 멤버에 호출해도 첫 부트스트랩 1회만 다운로드.
#   - OFFLINE(에어갭)/네트워크 불가면 스킵 — 그 박스는 어차피 자동업뎃 불가(사전설치 가정).
#   - 실패해도 exit 0 — 프로비저닝/업뎃을 막지 않는다. 멤버는 폴백으로 시스템 claude 사용(무회귀).
#   - 사용자 파일(settings/creds/rc) 안 건드림 — 네이티브 설치기가 자기 ~/.local + rc PATH 만 손댐.
#
# 사용: sudo bash install-claude-user.sh <osuser>   (root → 내부에서 runuser 로 그 유저 uid 로 설치)
#   채널: CLAUDE_INSTALL_CHANNEL(기본 latest — 맥미니와 동일 최신 추종). stable/버전 지정 가능.
# ─────────────────────────────────────────────────────────────────────────────
U="${1:-}"; [ -n "$U" ] || { echo "사용: sudo bash $0 <osuser>"; exit 0; }
id "$U" >/dev/null 2>&1 || { echo "  ⚠ 유저 없음: $U — 네이티브 claude 스킵"; exit 0; }
H="$(getent passwd "$U" | cut -d: -f6 || true)"
[ -n "$H" ] && [ -d "$H" ] || { echo "  ⚠ 홈 없음: $U — 네이티브 claude 스킵"; exit 0; }

# 이미 네이티브 설치돼 있으면(멤버 소유 self-update 바이너리) 재설치 불필요 — updater 가 최신화.
#  (root 는 700 홈 DAC 를 우회하므로 직접 확인 가능. 설치 '쓰기'만 멤버 uid(runuser)로 한다.)
if [ -x "$H/.local/bin/claude" ]; then
  echo "  ✓ $U — 네이티브 claude 이미 설치됨(self-update) — 스킵"; exit 0
fi

# 에어갭/오프라인이면 스킵(네이티브 설치기는 claude.ai 다운로드 필요).
if [ "${OFFLINE:-0}" = "1" ]; then
  echo "  ⚠ OFFLINE — $U 네이티브 claude 설치 스킵(사전설치 가정)"; exit 0
fi

# 채널 인자: 미설정이면 설치기 기본(latest GA)으로 — 인자 없이 호출(리터럴 'latest' 수용 여부에 무의존).
#  CLAUDE_INSTALL_CHANNEL 지정 시에만 그 값을 넘긴다(stable / 2.1.x 등).
CH="${CLAUDE_INSTALL_CHANNEL:-}"
echo "  … $U — Claude Code 네이티브 설치(채널=${CH:-기본(latest)}, 홈=$H)"
# 멤버 uid·비대화형. pipefail 로 curl 실패를 포착하고, 설치 후 실제 바이너리 존재로 성공 확정.
if runuser -u "$U" -- env HOME="$H" CH="$CH" bash -c \
     'set -o pipefail; if [ -n "$CH" ]; then curl -fsSL --max-time 120 https://claude.ai/install.sh | bash -s -- "$CH"; else curl -fsSL --max-time 120 https://claude.ai/install.sh | bash; fi' >/dev/null 2>&1 \
   && [ -x "$H/.local/bin/claude" ]; then
  echo "  ✓ $U — 네이티브 claude 설치 완료(~/.local/bin/claude · 이후 자동 업뎃)"
else
  echo "  ⚠ $U — 네이티브 claude 설치 실패(네트워크?) — 폴백=시스템 claude, 다음 프로비저닝/업뎃에 재시도"
fi
exit 0
