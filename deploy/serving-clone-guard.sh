#!/usr/bin/env bash
# 서빙 클론에 **커밋 금지 가드**를 심는다(pre-commit 훅) — 2026-08-26.
#
# 왜: 그 클론은 :8080 이 디스크째 서빙하는 자리다. 거기서 편집·커밋하면
#   ① 커밋 전 WIP 가 이미 라이브에 나가고(2026-06-30 충돌마커 서빙 사고),
#   ② 여러 세션이 부딪혀 주인 없는 stash 가 쌓이며(2026-08-26 실측 22개),
#   ③ stage 에만 먼저 쌓여 main 과 갭이 벌어진다(정산 전 369커밋).
#   작업은 워크트리에서 브랜치로 하고, 이 클론은 scripts/serve-sync.sh 로 **받기만** 한다.
#
# 성격: **막는 것이 아니라 멈춰 세우고 알려 주는 것**이다. 정말 급하면 `--no-verify` 로 넘길 수 있다
#   (git 의 표준 탈출구를 막지 않는다 — 막으면 사람이 훅을 지워 버려 가드 자체가 사라진다).
#   ⚠ 머지 커밋은 통과시킨다 — serve-sync.sh 가 아니라 사람이 stage 를 갱신하는 정당한 경로다.
#
# 쓰임:  deploy/serving-clone-guard.sh [--remove]
set -uo pipefail
CLONE="${LIVELY_SERVE_CLONE:-/Users/lively/.openclaw/workspace/productivity/lively}"
HOOK="$CLONE/.git/hooks/pre-commit"

[ -d "$CLONE/.git" ] || { echo "오류: 서빙 클론이 아니다 — $CLONE" >&2; exit 1; }

if [ "${1:-}" = "--remove" ]; then
  [ -f "$HOOK" ] && grep -q "lively:serving-clone-guard" "$HOOK" && rm -f "$HOOK" && echo "가드 제거: $HOOK" || echo "가드 없음"
  exit 0
fi

if [ -f "$HOOK" ] && ! grep -q "lively:serving-clone-guard" "$HOOK"; then
  echo "⚠ 이미 다른 pre-commit 훅이 있다 — 덮어쓰지 않는다: $HOOK" >&2; exit 1
fi

cat > "$HOOK" <<'HOOKEOF'
#!/usr/bin/env bash
# lively:serving-clone-guard — 이 클론은 :8080 이 서빙하는 자리다. 여기서 새 작업을 만들지 않는다.
# 머지 커밋(MERGE_HEAD 존재)은 stage 갱신의 정당한 경로라 통과시킨다.
[ -e "$(git rev-parse --git-dir)/MERGE_HEAD" ] && exit 0
cat >&2 <<'MSG'

  ⛔ 여기는 dev(:8080) 가 **디스크째 서빙하는 클론**입니다 — 새 작업을 여기서 만들지 마세요.

     여기서 편집하면 커밋 전 WIP 가 이미 라이브에 나가고, 여러 세션이 부딪혀
     주인 없는 stash 가 쌓입니다(2026-08-26 실측 22개, 가장 오래된 것 2026-06-18).

  ✅ 대신:
     1) 워크트리에서 작업합니다 — lively_local_repo_worktree {repo:"lively"}
     2) 브랜치를 push 하고, 그 브랜치를 stage 에 머지합니다(머지 커밋은 이 가드를 통과합니다).
     3) **같은 브랜치로 main PR 도 함께 엽니다** — 안 그러면 stage 에만 쌓여 갭이 벌어집니다.
     4) 이 클론은 scripts/serve-sync.sh 가 알아서 따라옵니다(직접 당길 필요 없음).

     자세히: 지식 「런북: dev :8080 게이트웨이 빌드·재시작」

  (정말 여기서 커밋해야 한다면 git commit --no-verify)

MSG
exit 1
HOOKEOF
chmod +x "$HOOK"
echo "가드 설치: $HOOK"
