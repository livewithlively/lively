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
# ★ 훅이 **둘**인 이유(2026-08-26 추가) — 통과시킨 그 정당한 경로가 정작 dev 를 얼렸다.
#   pre-commit 이 머지를 통과시키는데 **머지 뒤 push 를 강제하는 것이 없었다.** 그래서 이 클론에서
#   `git merge origin/main` 한 순간 HEAD 가 origin/stage 의 조상이 아니게 되고, serve-sync 는 ff 만
#   하므로 그때부터 **영구 스킵**한다 — 아무도 모르는 채 화면만 옛것이 나간다(실측 2026-08-26:
#   22분·15분 두 번, 미푸시 커밋이 17개까지 쌓였다). post-merge 가 그 마지막 한 걸음을 대신한다.
#   ⭐ 교훈: **탈출구를 열어 둘 거면 그 탈출구가 끝까지 가도록 배웅까지 해야 한다.** 반쯤 열어 두면
#    사람은 그 문으로 들어와서 중간에 멈추고, 그 자리가 곧 고장이 된다.
#
# 쓰임:  deploy/serving-clone-guard.sh [--remove]
set -uo pipefail
CLONE="${LIVELY_SERVE_CLONE:-/Users/lively/.openclaw/workspace/productivity/lively}"
HOOK="$CLONE/.git/hooks/pre-commit"
HOOK_MERGE="$CLONE/.git/hooks/post-merge"
HOOK_COMMIT="$CLONE/.git/hooks/post-commit"

[ -d "$CLONE/.git" ] || { echo "오류: 서빙 클론이 아니다 — $CLONE" >&2; exit 1; }

if [ "${1:-}" = "--remove" ]; then
  for h in "$HOOK" "$HOOK_MERGE" "$HOOK_COMMIT"; do
    if [ -f "$h" ] && grep -q "lively:serving-clone-guard" "$h"; then rm -f "$h"; echo "가드 제거: $h"; fi
  done
  exit 0
fi

for h in "$HOOK" "$HOOK_MERGE" "$HOOK_COMMIT"; do
  if [ -f "$h" ] && ! grep -q "lively:serving-clone-guard" "$h"; then
    echo "⚠ 이미 다른 훅이 있다 — 덮어쓰지 않는다: $h" >&2; exit 1
  fi
done

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
     2) 브랜치를 push 하고, 그 브랜치를 stage 에 머지합니다
        (머지 커밋은 이 가드를 통과하고, 머지가 끝나면 **자동으로 push 됩니다**).
     3) **같은 브랜치로 main PR 도 함께 엽니다** — 안 그러면 stage 에만 쌓여 갭이 벌어집니다.
     4) 이 클론은 scripts/serve-sync.sh 가 알아서 따라옵니다(직접 당길 필요 없음).

     자세히: 지식 「런북: dev :8080 게이트웨이 빌드·재시작」

  (정말 여기서 커밋해야 한다면 git commit --no-verify)

MSG
exit 1
HOOKEOF
chmod +x "$HOOK"
echo "가드 설치: $HOOK"

cat > "$HOOK_MERGE" <<'HOOKEOF'
#!/usr/bin/env bash
# lively:serving-clone-guard(post-merge) — 머지했으면 **그 자리에서 push 한다**.
#  pre-commit 이 머지를 '정당한 경로'로 통과시키는데 push 는 아무도 안 시켰다. 그 반 걸음이 dev 를 얼렸다
#  (serve-sync 는 ff 만 한다 → 미푸시 커밋이 하나라도 있으면 영구 스킵). 여기서 그 걸음을 마저 걷는다.
set -uo pipefail
[ "${1:-0}" = "1" ] && exit 0                        # squash 머지 — 만들어진 커밋이 없다
br="$(git symbolic-ref --short -q HEAD || true)"
[ "$br" = "stage" ] || exit 0                        # 서빙 브랜치일 때만(다른 브랜치는 남의 실험이다)
git rev-parse --abbrev-ref '@{u}' >/dev/null 2>&1 || exit 0    # 추적 원격이 없으면 올릴 곳도 없다
n="$(git rev-list --count '@{u}..HEAD' 2>/dev/null || echo 0)"
[ "${n:-0}" -gt 0 ] || exit 0                        # ff 로 받기만 한 머지(serve-sync 자신) — 올릴 것이 없다
if git push origin "$br" >/dev/null 2>&1; then
  echo "✅ [serving-clone-guard] stage 를 원격에 올렸습니다(${n}커밋) — serve-sync 가 안 막힙니다." >&2
else
  cat >&2 <<'MSG'
⚠ [serving-clone-guard] 자동 push 가 거부됐습니다(그새 원격이 앞섰을 수 있습니다).
   지금 직접 올려 주세요:  git pull --rebase origin stage && git push origin stage
   안 올리면 serve-sync 가 "미푸시 커밋"으로 **영구 스킵**해 dev 가 옛 화면에서 멈춥니다.
MSG
fi
exit 0
HOOKEOF
chmod +x "$HOOK_MERGE"
echo "가드 설치: $HOOK_MERGE"

cat > "$HOOK_COMMIT" <<'HOOKEOF'
#!/usr/bin/env bash
# lively:serving-clone-guard(post-commit) — **충돌을 해결하고 마무리한 머지**도 그 자리에서 push 한다.
#  ⭐ 왜 post-merge 만으로 안 되나: git 은 `git merge` 가 스스로 커밋을 만들 때만 post-merge 를 부른다.
#   충돌이 나면 머지는 멈추고 사람이 `git commit` 으로 마무리하는데, 그 길에는 post-merge 가 **안 불린다**.
#   그런데 main↔stage 처럼 벌어진 두 갈래를 머지하면 충돌은 예외가 아니라 기본값이다 — 즉 자동 push 가
#   가장 필요한 경로가 정확히 비어 있었다(2026-08-26, 이 가드를 고치다 테스트로 잡았다).
#  ⚠ 머지 커밋(부모 2개 이상)일 때만 민다 — 부모가 하나면 `--no-verify` 로 낸 남의 직접 커밋이고,
#   그건 대신 공개하지 않는다(가드의 원래 원칙).
set -uo pipefail
br="$(git symbolic-ref --short -q HEAD || true)"
[ "$br" = "stage" ] || exit 0
[ "$(git rev-list --no-walk --count --merges HEAD 2>/dev/null || echo 0)" = "1" ] || exit 0
git rev-parse --abbrev-ref '@{u}' >/dev/null 2>&1 || exit 0
n="$(git rev-list --count '@{u}..HEAD' 2>/dev/null || echo 0)"
[ "${n:-0}" -gt 0 ] || exit 0
if git push origin "$br" >/dev/null 2>&1; then
  echo "✅ [serving-clone-guard] 충돌 해결 머지를 원격에 올렸습니다(${n}커밋)." >&2
else
  echo "⚠ [serving-clone-guard] 자동 push 거부 — git pull --rebase origin stage && git push origin stage 로 올려 주세요(안 올리면 dev 가 언 채로 있습니다)." >&2
fi
exit 0
HOOKEOF
chmod +x "$HOOK_COMMIT"
echo "가드 설치: $HOOK_COMMIT"
