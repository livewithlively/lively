#!/usr/bin/env bash
# dev 서빙 클론을 origin/stage 로 따라가게 한다 — **당기기만 한다(읽기 전용)**.
#
# 왜 이게 생겼나 (2026-08-26)
#   서빙 클론(/Users/lively/.openclaw/workspace/productivity/lively)이 세 역할을 겸하고 있었다:
#   ① 작업 공간(사람·AI 가 거기서 직접 편집·커밋) ② 배포 산출물(:8080 이 그 디스크를 그대로 서빙)
#   ③ 통합 지점(stage 브랜치). 셋이 한 디렉터리라서 대가가 컸다 —
#     · 커밋 전 WIP 가 이미 라이브에 나간다(2026-06-30 충돌마커가 :8080 에 서빙돼 화면이 죽었다),
#     · 여러 세션이 한 클론을 공유해 autostash·index.lock 이 부딪히고 **주인 없는 stash 가 22개** 쌓였다
#       (가장 오래된 것 2026-06-18 — 두 달 방치),
#     · stage 에만 먼저 쌓여 main 과 갭이 벌어졌다(2026-08-26 정산 전 369커밋·6일).
#   그래서 ①을 떼어낸다. 작업은 워크트리에서 브랜치로 하고, 이 클론은 **결과를 받기만** 한다.
#
# 안전 원칙 — **남의 작업을 절대 날리지 않는다**
#   `git reset --hard` 를 쓰지 않는다. 작업트리가 깨끗할 때만 fast-forward 하고,
#   WIP·머지중·미푸시 커밋이 하나라도 있으면 **아무것도 하지 않고 그 사실을 알린다**.
#   이 스크립트가 사람의 판단을 대신하는 자리는 없다(그게 이 파일의 유일한 안전 근거다).
#
# 쓰임
#   scripts/serve-sync.sh            # 한 번 동기화(깨끗할 때만)
#   scripts/serve-sync.sh --check    # 판정만 — 아무것도 바꾸지 않는다
#   launchd io.lvly.stage-sync 가 주기 실행한다(deploy/io.lvly.stage-sync.plist).
set -uo pipefail

CLONE="${LIVELY_SERVE_CLONE:-/Users/lively/.openclaw/workspace/productivity/lively}"
BRANCH="${LIVELY_SERVE_BRANCH:-stage}"
CHECK_ONLY=0
[ "${1:-}" = "--check" ] && CHECK_ONLY=1

say() { printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*"; }
skip() { say "건너뜀 — $*"; exit 0; }   # 정상 종료: 이 스크립트가 손대면 안 되는 상태라는 뜻이다

[ -d "$CLONE/.git" ] || { say "오류: 서빙 클론이 아니다 — $CLONE"; exit 1; }
git -C "$CLONE" rev-parse --git-dir >/dev/null 2>&1 || { say "오류: git 레포가 아니다 — $CLONE"; exit 1; }

cur=$(git -C "$CLONE" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "?")
[ "$cur" = "$BRANCH" ] || skip "체크아웃이 $BRANCH 가 아니다(현재 $cur) — 사람이 무언가 하는 중일 수 있다"

# ── 손대면 안 되는 상태 넷 ─────────────────────────────────────────────────────
git -C "$CLONE" rev-parse -q --verify MERGE_HEAD >/dev/null 2>&1 && skip "머지 진행 중(MERGE_HEAD)"
[ -n "$(git -C "$CLONE" ls-files -u 2>/dev/null)" ] && skip "미해소 충돌(unmerged)이 있다"
for d in rebase-merge rebase-apply CHERRY_PICK_HEAD; do
  [ -e "$CLONE/.git/$d" ] && skip "$d 진행 중"
done
dirty=$(git -C "$CLONE" status --porcelain 2>/dev/null)
[ -n "$dirty" ] && skip "작업트리에 변경이 있다(남의 WIP 일 수 있다):
$(printf '%s\n' "$dirty" | head -10 | sed 's/^/    /')"

git -C "$CLONE" fetch -q origin "$BRANCH" || { say "오류: fetch 실패"; exit 1; }
local_sha=$(git -C "$CLONE" rev-parse HEAD)
remote_sha=$(git -C "$CLONE" rev-parse "origin/$BRANCH")
[ "$local_sha" = "$remote_sha" ] && { [ $CHECK_ONLY -eq 1 ] && say "최신 — ${local_sha:0:8}"; exit 0; }

# 미푸시 커밋이 있으면 그 사람이 아직 올리지 않은 것이다 — 앞질러 가지 않는다.
ahead=$(git -C "$CLONE" rev-list --count "origin/$BRANCH..HEAD")
[ "$ahead" -gt 0 ] && skip "미푸시 커밋 ${ahead}개가 있다(남의 작업을 대신 공개하지 않는다)"

behind=$(git -C "$CLONE" rev-list --count "HEAD..origin/$BRANCH")
if [ $CHECK_ONLY -eq 1 ]; then say "동기화 필요 — ${behind}커밋 뒤짐(${local_sha:0:8} → ${remote_sha:0:8})"; exit 0; fi

say "동기화 — ${behind}커밋 (${local_sha:0:8} → ${remote_sha:0:8})"
git -C "$CLONE" merge --ff-only "origin/$BRANCH" >/dev/null || { say "오류: ff 실패(히스토리가 갈렸다) — 사람이 봐야 한다"; exit 1; }

# 웹 산출물은 git 밖이므로(#2054) 받은 소스로 **여기서** 다시 만든다. 안 만들면 :8080 이 옛 화면을 서빙한다.
if ! git -C "$CLONE" diff --quiet "$local_sha" HEAD -- web/ public/styles/ 2>/dev/null; then
  say "web 변경 있음 — build:web"
  ( cd "$CLONE" && rm -f .tsbuildinfo-web && npm run build:web >/dev/null 2>&1 ) \
    || { say "⚠ build:web 실패 — 옛 산출물이 그대로 서빙된다(사람이 봐야 한다)"; exit 1; }
fi

# src/** 가 바뀌었으면 게이트웨이가 새 코드를 들어야 한다. 빌드 실패면 restart-gateway.sh 가 스스로 멈춘다.
if ! git -C "$CLONE" diff --quiet "$local_sha" HEAD -- src/ 2>/dev/null; then
  say "src 변경 있음 — restart-gateway.sh"
  ( cd "$CLONE" && scripts/restart-gateway.sh >/dev/null 2>&1 ) \
    || { say "⚠ 게이트웨이 재시작 실패 — 기존 프로세스는 그대로 살아 있다"; exit 1; }
fi

code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 localhost:8080/healthz || echo "000")
say "완료 — HEAD ${remote_sha:0:8} · healthz $code"
