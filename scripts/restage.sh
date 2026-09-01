#!/usr/bin/env bash
set -euo pipefail
# ─────────────────────────────────────────────────────────────────────────────
# stage 브랜치 재조립 — main 을 새 바닥으로 깔고, stage 에 얹혀 있던 브랜치들을 다시 머지한다.
#
# stage 가 뭔가: dev 게이트웨이가 서빙하는 "검증 중인 것들을 한 데 모아 돌려보는" 브랜치다.
#   main 처럼 보호하지 않고 직접 push 를 허용한다(그게 목적이니까). 대신 **영속 자산이 아니다** —
#   여기 있는 것의 정본은 각 작업 브랜치이고, stage 는 그것들의 합성 결과일 뿐이다.
#   그래서 main 이 앞서 나가면 stage 를 버리고 다시 만든다. 이 스크립트가 그 "다시 만들기"다.
#
# ⚠ 이 스크립트가 존재하는 이유 = 손으로 하면 조용히 날아가는 게 있다.
#   손으로 `git reset --hard origin/main` + "열린 PR 들 다시 머지" 를 하면 두 가지가 사라진다:
#     (1) stage 에 직접 커밋한 것 — dev 에서 돌려보다 급하게 한 줄 고쳐 push 한 경우.
#     (2) stage 에 머지했지만 아직 PR 을 안 만든 브랜치 — 검증 끝나면 PR 내려던 것.
#   (2)가 특히 위험하다. 'PR 목록'을 재조립 기준으로 삼으면 통째로 빠지는데, 빠진 게 눈에 안 띈다.
#   그래서 이 스크립트는 **재조립 대상을 PR 이 아니라 stage 자신에게 묻는다**(§3).
#
# 3중 안전장치:
#   ① 고아 커밋 검사 — stage 에만 있는 직접 커밋이 있으면 **재조립하지 않고 중단**한다(§2).
#      "날아갈 게 있으면 아예 시작하지 않는다". 사람이 그 커밋을 원래 브랜치로 옮긴 뒤 다시 돌린다.
#   ② 백업 태그 — force push 직전 현재 stage 를 태그로 남긴다(§4). 사고가 나도 통째로 복구된다.
#   ③ --force-with-lease — 검사한 뒤 누가 stage 에 push 했으면 거부된다(§6).
#
# 사용:
#   scripts/restage.sh                 # 재조립(대상 자동 산출) — 진행 전 확인을 묻는다
#   scripts/restage.sh --dry-run       # 뭘 할지만 보여주고 아무것도 바꾸지 않는다
#   scripts/restage.sh --yes           # 확인 없이 진행(CI·자동화용)
#   scripts/restage.sh feat/a          # 자동 산출 결과 + feat/a 를 함께 얹는다(대체 아님)
#   scripts/restage.sh --only feat/a   # 자동 산출을 버리고 feat/a 만 얹는다
#   scripts/restage.sh --allow-orphans # ①을 경고로 낮춤 — 백업 태그를 확인하고 정말 버릴 때만
#
# 작업은 임시 워크트리에서 한다 — 당신이 지금 체크아웃해 둔 브랜치를 건드리지 않는다.
# 환경변수: RESTAGE_REMOTE(기본 origin) · RESTAGE_BASE(main) · RESTAGE_STAGE(stage)
#           RESTAGE_KEEP_BACKUPS(10) — 남겨둘 백업 태그 개수. 0 이면 정리 안 함.
# ─────────────────────────────────────────────────────────────────────────────

REMOTE="${RESTAGE_REMOTE:-origin}"
BASE="${RESTAGE_BASE:-main}"
STAGE="${RESTAGE_STAGE:-stage}"

DRY_RUN=0
ASSUME_YES=0
ALLOW_ORPHANS=0
ONLY=0
EXPLICIT_TARGETS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --yes|-y) ASSUME_YES=1 ;;
    --allow-orphans) ALLOW_ORPHANS=1 ;;
    --only) ONLY=1 ;;
    -h|--help) sed -n '3,40p' "$0"; exit 0 ;;
    -*) echo "✗ 모르는 옵션: $1" >&2; exit 2 ;;
    *) EXPLICIT_TARGETS+=("$1") ;;
  esac
  shift
done

say() { printf '%s\n' "$*"; }
die() { printf '✗ %s\n' "$*" >&2; exit 1; }

# 확인 프롬프트 — 파이프·CI 처럼 tty 가 없으면 물어볼 수 없다. 조용히 진행하는 대신 명확히 세운다.
confirm() {
  [[ "$ASSUME_YES" == 1 ]] && return 0
  [[ -t 0 ]] || die "확인이 필요한데 입력이 tty 가 아닙니다 — 자동 실행이면 --yes 를 붙이세요."
  local ans; read -r -p "$1 [y/N] " ans
  [[ "$ans" == "y" || "$ans" == "Y" ]]
}

git rev-parse --git-dir >/dev/null 2>&1 || die "git 레포 안에서 실행하세요."

# ── §1. 최신 상태 확보 ────────────────────────────────────────────────────────
say "▸ ${REMOTE} fetch…"
git fetch "$REMOTE" --prune --quiet

git rev-parse --verify --quiet "${REMOTE}/${BASE}" >/dev/null || die "${REMOTE}/${BASE} 가 없습니다."
git rev-parse --verify --quiet "${REMOTE}/${STAGE}" >/dev/null || die "${REMOTE}/${STAGE} 가 없습니다."

BASE_SHA="$(git rev-parse "${REMOTE}/${BASE}")"
STAGE_SHA="$(git rev-parse "${REMOTE}/${STAGE}")"   # ③ lease 의 기준값 — 여기서 고정한다.

# stage 가 이미 base 와 같으면 **되돌릴 것**이 없다 — 단 인자로 브랜치를 받았다면 얘기가 다르다.
#  ⚠ 종전엔 여기서 무조건 exit 0 이라, `restage.sh project/X` 가 "재조립할 것이 없습니다" 한 줄과 함께
#   **조용히 무시**됐다. 요청한 사람은 성공으로 읽는다(종료코드 0). 이 상태는 흔하다: 방금 재조립해
#   stage 를 비운 직후, 또는 stage 를 main 으로 리셋한 뒤 브랜치 하나만 얹으려는 경우.
#   '얹을 것이 있는데 안 얹는' 것은 이 스크립트가 막으려는 유실과 같은 부류다.
if [[ "$BASE_SHA" == "$STAGE_SHA" && ${#EXPLICIT_TARGETS[@]} -eq 0 ]]; then
  say "✓ ${STAGE} = ${BASE} (동일) — 재조립할 것이 없습니다."
  say "  (특정 브랜치를 얹으려면 인자로 지정하세요: scripts/restage.sh <브랜치>)"
  exit 0
fi

# ── §2. 안전장치① 고아 커밋 검사 ──────────────────────────────────────────────
# stage 에 "직접" 올린 커밋만 찾아야 한다. --first-parent 가 핵심이다:
#   그냥 `--no-merges ${BASE}..${STAGE}` 는 머지로 딸려 들어온 **작업 브랜치의 커밋까지 전부** 잡는다
#   (그 커밋들도 main 에는 없으니까). 그러면 정상 상태에서도 매번 오탐이 나 검사가 무력해진다.
#   --first-parent 는 stage 의 몸통 선만 따라가므로, 머지로 들어온 쪽(2번째 부모)은 보지 않는다.
#   → 남는 건 stage 위에 직접 얹힌 커밋뿐 = 재조립하면 진짜로 사라지는 것.
DIRECT="$(git rev-list --first-parent --no-merges "${BASE_SHA}..${REMOTE}/${STAGE}" || true)"

# 직접 커밋이 있어도 곧바로 "유실"은 아니다 — 같은 내용이 이미 작업 브랜치에 올라가 있으면 안전하다.
# (위 안내대로 cherry-pick 해서 브랜치로 옮기면 SHA 는 달라지지만 패치는 같다. SHA 로만 보면
#  옮긴 뒤에도 계속 막혀서, 안내를 따라도 빠져나갈 수 없는 검사가 된다.)
# `git cherry <브랜치> <C> <C^>` 가 딱 그 판정을 한다: 패치가 동등한 커밋이 그 브랜치에 있으면 '-'.
#
# ⚠ 속도 (2026-09-01, #2457) — 종전은 **직접커밋 × 후보브랜치** 로 `git cherry` 를 돌렸다. 그게 이 검사를
#  사실상 못 끝나게 만들었다: 실측 stage 직접커밋 109 × 후보 620 ≈ **6만7천 회**, 각 호출이 그 브랜치의
#  히스토리를 훑어 patch-id 를 새로 계산한다. 2026-08-25 에 이미 «restage 가 끝나지 않는다»로 기록됐고
#  (150×309≈4.6만, "날 단위"), 그 문서가 처방까지 적어 뒀다 — **patch-id 를 한 번만 계산해 대조하라.**
#  여기서 그렇게 바꾼다: 후보 커밋 전체(실측 948건)의 patch-id 집합을 **1회** 만들고 대조한다 → N×M → N+M.
#  판정 자체는 종전과 같다(patch 동등성). '어느 브랜치에 있나'는 매칭된 소수에만 물어본다.
ORPHANS=""
RESCUED=""
if [[ -n "$DIRECT" ]]; then
  # 후보는 '아직 main 에 안 들어간 origin 브랜치'뿐. `--no-merged` 가 그 판정을 ref 순회 1회로 한다
  #  (종전엔 브랜치마다 merge-base 를 불러 620회였다).
  #  ⚠ macOS 기본 bash 는 3.2 라 `mapfile` 이 없다(bash 4+). while-read 로 담는다.
  CAND=()
  while IFS= read -r b; do
    [[ -n "$b" ]] && CAND+=("$b")
  done < <(git for-each-ref --format='%(refname:strip=3)' --no-merged "$BASE_SHA" "refs/remotes/${REMOTE}" \
             | grep -vxE "HEAD|${STAGE}|${BASE}" || true)
  # 후보에서 patch-id 집합을 한 번에 만든다. `git log -p` 의 커밋 헤더 덕에 patch-id 가
  #  "<patch-id> <커밋sha>" 짝을 뱉는다(= git cherry 가 내부에서 하는 것과 같은 판정).
  #
  # ⚠ **범위에 main 을 반드시 포함한다.** `git cherry <브랜치> <C> <C^>` 는 그 브랜치의 **전체 히스토리**를
  #  보므로 main 에 이미 들어간 쌍둥이도 잡는다. 여기서 main 을 빼면 **바로 그 쌍둥이를 놓쳐** 멀쩡한 커밋이
  #  고아로 뒤집힌다 — 실측(2026-09-01): 그렇게 해서 고아가 14건 → 106건으로 부풀었다
  #  (예: `6d486354` 는 main 과 project/2439-all-harness 양쪽에 patch 가 있는데 KNOWN 에서 빠졌다).
  # 하한은 **공통 조상**이면 충분하다 — stage 직접커밋은 그 뒤에 생겼으니 쌍둥이도 그 뒤다.
  #  전체 히스토리를 뜨면 수만 커밋의 diff 를 계산하게 되어, 고치려던 그 느림으로 되돌아간다.
  KNOWN="$(mktemp)"; MINE="$(mktemp)"
  #  main 은 위 ①이 `git cherry` 로 정확히 보므로 여기선 뺀다 — 집합은 '나머지 후보 브랜치' 몫이다.
  if [[ ${#CAND[@]} -gt 0 ]]; then
    git log -p --no-merges "${CAND[@]/#/${REMOTE}/}" --not "$BASE_SHA" 2>/dev/null \
      | git patch-id --stable > "$KNOWN" || true
  fi
  for c in $DIRECT; do git show "$c" 2>/dev/null; done | git patch-id --stable > "$MINE" || true

  for c in $DIRECT; do
    line="$(git log -1 --format='%h  %an  %s' "$c")"
    # ① main 을 먼저, `git cherry` 로 본다 — 압도적으로 흔한 출처이고(실측 108건 중 **98건**),
    #    전체 히스토리를 보므로 공통 조상보다 앞서 머지된 쌍둥이도 정확히 잡는다. 108건에 4초.
    #    (집합 스캔의 하한을 공통 조상에 두면 그 옛 쌍둥이를 놓쳐 멀쩡한 커밋이 고아로 뒤집힌다 —
    #     실측 2026-09-01: `cdfbfa96` 가 그렇게 거짓 고아가 됐다.)
    if git cherry "${REMOTE}/${BASE}" "$c" "${c}^" 2>/dev/null | grep -q '^-'; then
      RESCUED+="${line}   → ${BASE} 에 있음"$'\n'
      continue
    fi
    # ② 남은 소수만 후보 브랜치 patch-id 집합과 대조한다.
    pid="$(awk -v c="$c" '$2 ~ "^"c {print $1; exit}' "$MINE")"
    twin=""
    [[ -n "$pid" ]] && twin="$(awk -v p="$pid" '$1==p {print $2; exit}' "$KNOWN")"
    if [[ -n "$twin" ]]; then
      # 매칭은 소수라 여기서만 브랜치 이름을 묻는다(비싼 호출을 전수로 돌리지 않는다).
      saved="$(git for-each-ref --format='%(refname:strip=3)' --contains "$twin" "refs/remotes/${REMOTE}" 2>/dev/null \
                 | grep -vxE "HEAD|${STAGE}" | head -1)"
      RESCUED+="${line}   → ${saved:-작업 브랜치} 에 있음"$'\n'
    else
      ORPHANS+="${line}"$'\n'
    fi
  done
  rm -f "$KNOWN" "$MINE"
fi

if [[ -n "$RESCUED" ]]; then
  say "▸ ${STAGE} 직접 커밋이지만 이미 작업 브랜치에 올라가 있음(안전):"
  printf '%s' "$RESCUED" | sed 's/^/    /'
fi

BLOCKED=0
if [[ -n "$ORPHANS" ]]; then
  say ""
  say "⚠ ${STAGE} 에 직접 올린 커밋이 있습니다 — 재조립하면 사라집니다:"
  printf '%s' "$ORPHANS" | sed 's/^/    /'
  say ""
  if [[ "$ALLOW_ORPHANS" == 1 ]]; then
    say "  --allow-orphans 지정됨 — 경고만 하고 진행합니다."
  else
    say "  이 커밋들은 어느 작업 브랜치에도 없습니다."
    say ""
    say "  해결: 각 커밋을 원래 있어야 할 브랜치로 옮긴 뒤 다시 실행하세요."
    say "    git checkout -b fix/<이름> ${REMOTE}/${BASE}"
    say "    git cherry-pick <위 해시>"
    say "    git push -u ${REMOTE} fix/<이름>"
    say "  옮기면 이 검사는 통과합니다(내용이 같으면 SHA 가 달라도 알아봅니다)."
    say "  단, 옮긴 브랜치는 ${STAGE} 에 머지된 적이 없으니 재조립 대상에서는 빠집니다 —"
    say "  계속 ${STAGE} 에서 돌려보려면 인자로 지정하세요: scripts/restage.sh fix/<이름>"
    say ""
    say "  정말 버릴 거면: --allow-orphans (백업 태그는 그래도 남습니다)"
    # --dry-run 은 여기서 죽지 않는다 — 뭐가 막고 있는지'와' 재조립 계획을 같이 보여줘야 쓸모가 있다.
    [[ "$DRY_RUN" == 1 ]] || exit 1
    BLOCKED=1
  fi
fi

# ── §3. 재조립 대상 산출 ──────────────────────────────────────────────────────
# **PR 목록에서 뽑지 않는다.** PR 을 아직 안 만든 브랜치가 통째로 빠지기 때문이다.
# 대신 stage 의 머지 커밋을 역산한다 — "지금 stage 에 실제로 얹혀 있는 것"이 기준이므로
# PR 유무와 무관하게 보존된다.
#   --first-parent: stage 위에서 일어난 머지만. (작업 브랜치 내부의 머지는 대상이 아니다.)
#   --reverse:      원래 머지된 순서대로 다시 머지한다.
#   M^2:            머지 커밋의 2번째 부모 = 그때 머지해 들어온 쪽의 끝점.
#
# 인자로 브랜치를 주면 자동 산출 결과에 **더한다**(대체가 아니다). 대체가 기본이면
# `restage.sh fix/hot` 한 번에 나머지가 통째로 날아간다 — 이 스크립트가 막으려는 바로 그 사고다.
# 정말 대체하려면 --only 를 명시한다.
TARGETS=()
UNRESOLVED=()
if [[ "$ONLY" == 1 ]]; then
  say "▸ --only — 자동 산출을 건너뛰고 인자로 지정된 ${#EXPLICIT_TARGETS[@]}개만 얹습니다."
else
  while read -r m; do
    [[ -n "$m" ]] || continue
    p2="$(git rev-parse --verify --quiet "${m}^2" || true)"
    [[ -n "$p2" ]] || continue
    # 1순위: 그 커밋을 지금도 가리키는 origin 브랜치(가장 확실).
    #  ⚠ `|| true` 필수 — 가리키는 브랜치가 없으면 grep 이 1 을 반환하고, set -e + pipefail 이 여기서
    #   **스크립트를 통째로 죽인다**(2순위로 못 넘어간다). 그런데 '없음'은 예외가 아니라 정상이다:
    #   재조립 뒤 그 브랜치에 커밋을 하나만 더 얹어도 tip 이 머지지점을 지나 --points-at 이 빈다.
    #   즉 **restage 재실행이라는 가장 흔한 경로에서 매번 죽었다**(증상: "▸ origin fetch…" 만 찍고 종료 1).
    name="$(git for-each-ref --format='%(refname:strip=3)' --points-at "$p2" "refs/remotes/${REMOTE}" | grep -v '^HEAD$' | head -1 || true)"
    # 2순위: 머지 커밋 제목에 박힌 브랜치명. 브랜치가 그 뒤로 더 진행돼 tip 이 안 맞을 때 쓴다.
    if [[ -z "$name" ]]; then
      subj="$(git log -1 --format='%s' "$m")"
      name="$(printf '%s' "$subj" | sed -n "s/.*branch '\([^']*\)'.*/\1/p" | sed "s|^${REMOTE}/||")"
    fi
    if [[ -z "$name" ]] || ! git rev-parse --verify --quiet "${REMOTE}/${name}" >/dev/null; then
      UNRESOLVED+=("$(git log -1 --format='%h %s' "$m")")
      continue
    fi
    # 중복 제거 — 같은 브랜치를 여러 번 머지했을 수 있다(마지막 상태만 필요).
    dup=0; for t in ${TARGETS[@]+"${TARGETS[@]}"}; do [[ "$t" == "$name" ]] && dup=1; done
    [[ "$dup" == 1 ]] || TARGETS+=("$name")
  done < <(git rev-list --merges --first-parent --reverse "${BASE_SHA}..${REMOTE}/${STAGE}")
fi

# 인자 브랜치를 뒤에 덧붙인다(이미 산출된 건 건너뜀).
for t in ${EXPLICIT_TARGETS[@]+"${EXPLICIT_TARGETS[@]}"}; do
  git rev-parse --verify --quiet "${REMOTE}/${t}" >/dev/null || die "${REMOTE}/${t} 가 없습니다."
  dup=0; for x in ${TARGETS[@]+"${TARGETS[@]}"}; do [[ "$x" == "$t" ]] && dup=1; done
  [[ "$dup" == 1 ]] || TARGETS+=("$t")
done

# 대상을 못 알아낸 머지가 있으면 조용히 넘기지 않는다 — 그게 곧 유실이다.
if [[ ${#UNRESOLVED[@]} -gt 0 ]]; then
  say ""
  say "⚠ 어떤 브랜치였는지 알 수 없는 머지가 있습니다(브랜치가 삭제됐을 수 있음):"
  printf '%s\n' "${UNRESOLVED[@]}" | sed 's/^/    /'
  say ""
  say "  이미 ${BASE} 에 들어갔다면 무시해도 됩니다. 아니라면 재조립 후 사라집니다."
  say "  확인: git log --oneline ${BASE_SHA}..${REMOTE}/${STAGE}"
  if [[ "$ALLOW_ORPHANS" != 1 && "$DRY_RUN" != 1 ]]; then
    confirm "  그래도 진행할까요?" || { say "중단했습니다."; exit 1; }
  fi
fi

# 이미 base 에 들어간 브랜치는 제외 — 머지해도 no-op 이고, 목록만 지저분해진다.
KEEP=()
for t in ${TARGETS[@]+"${TARGETS[@]}"}; do
  if git merge-base --is-ancestor "${REMOTE}/${t}" "$BASE_SHA" 2>/dev/null; then
    say "  · ${t} — 이미 ${BASE} 에 병합됨, 제외"
  else
    KEEP+=("$t")
  fi
done
TARGETS=(${KEEP[@]+"${KEEP[@]}"})

say ""
say "▸ 재조립 계획"
say "    바닥:   ${REMOTE}/${BASE}  (${BASE_SHA:0:8})"
say "    현재:   ${REMOTE}/${STAGE} (${STAGE_SHA:0:8})"
if [[ ${#TARGETS[@]} -eq 0 ]]; then
  say "    다시 머지할 브랜치: 없음 — ${STAGE} 를 ${BASE} 기준으로 되돌리기만 합니다."
else
  say "    다시 머지할 브랜치(${#TARGETS[@]}개):"
  for t in "${TARGETS[@]}"; do say "      - ${t}"; done
fi
say ""

if [[ "$DRY_RUN" == 1 ]]; then
  say "(--dry-run — 아무것도 바꾸지 않았습니다)"
  [[ "$BLOCKED" == 1 ]] && say "⚠ 실제 실행은 위 고아 커밋 때문에 중단됩니다 — 먼저 옮기거나 --allow-orphans 를 쓰세요."
  exit 0
fi

confirm "진행할까요?" || { say "중단했습니다."; exit 1; }

# ── §4. 안전장치② 백업 태그 ──────────────────────────────────────────────────
# force push 로 덮기 전에 현재 stage 를 원격에 태그로 박아둔다. 이후 뭐가 잘못돼도
#   git reset --hard <태그>  로 통째로 되돌릴 수 있다. 태그는 싸다 — 남기고 나중에 지운다.
TAG="stage-backup-$(date +%Y%m%d-%H%M%S)"
say "▸ 백업 태그 ${TAG} → ${STAGE_SHA:0:8}"
git tag -f "$TAG" "$STAGE_SHA"
git push --quiet "$REMOTE" "refs/tags/${TAG}"
say "  복구가 필요하면: git push --force ${REMOTE} ${TAG}^{commit}:${STAGE}"

# 오래된 백업 태그 정리 — 공개 레포의 태그 목록은 사람이 보는 표면이라, 안 지우면
# stage-backup-* 이 릴리스 태그를 파묻는다. 이름이 시간순 정렬되므로 최근 N개만 남긴다.
# N=10 이면 10번 전 재조립까지 되돌릴 수 있다(그보다 옛 stage 를 복구할 일은 없다).
KEEP_TAGS="${RESTAGE_KEEP_BACKUPS:-10}"
ALL_TAGS="$(git ls-remote --tags "$REMOTE" 'refs/tags/stage-backup-*' 2>/dev/null \
             | sed 's|.*refs/tags/||' | grep -v '\^{}$' | sort || true)"
N_TAGS="$(printf '%s' "$ALL_TAGS" | grep -c . || true)"
if [[ "$KEEP_TAGS" -gt 0 && "${N_TAGS:-0}" -gt "$KEEP_TAGS" ]]; then
  # head -n -N 은 GNU 전용이라 macOS 에서 안 된다 — 지울 개수를 직접 세서 앞에서 자른다.
  DROP="$(printf '%s\n' "$ALL_TAGS" | head -n "$((N_TAGS - KEEP_TAGS))")"
  say "  오래된 백업 태그 $((N_TAGS - KEEP_TAGS))개 정리(최근 ${KEEP_TAGS}개 유지)"
  while read -r t; do
    [[ -n "$t" ]] || continue
    git push --quiet "$REMOTE" --delete "refs/tags/${t}" 2>/dev/null || true
    git tag -d "$t" >/dev/null 2>&1 || true
  done <<< "$DROP"
fi

# ── §5. 임시 워크트리에서 재조립 ─────────────────────────────────────────────
# 당신이 체크아웃해 둔 브랜치를 건드리지 않기 위해 별도 워크트리를 쓴다.
# 머지 충돌로 실패해도 이 디렉터리만 지우면 끝이라, 중간 상태가 남지 않는다.
WT="$(mktemp -d "${TMPDIR:-/tmp}/restage-XXXXXX")/wt"
cleanup() { git worktree remove --force "$WT" >/dev/null 2>&1 || true; rm -rf "$(dirname "$WT")" >/dev/null 2>&1 || true; }
trap cleanup EXIT

say "▸ 임시 워크트리에서 재조립…"
git worktree add --quiet --detach "$WT" "$BASE_SHA"

FAILED=()
MERGED=0
for t in ${TARGETS[@]+"${TARGETS[@]}"}; do
  if git -C "$WT" merge --no-ff --quiet -m "Merge branch '${t}' into ${STAGE}" "${REMOTE}/${t}" >/dev/null 2>&1; then
    MERGED=$((MERGED + 1))
    say "  ✓ ${t}"
  else
    git -C "$WT" merge --abort >/dev/null 2>&1 || true
    FAILED+=("$t")
    say "  ✗ ${t} — 충돌, 건너뜀"
  fi
done

if [[ ${#FAILED[@]} -gt 0 ]]; then
  say ""
  say "⚠ 충돌로 못 얹은 브랜치(${#FAILED[@]}개): ${FAILED[*]}"
  say "  ${BASE} 브랜치가 앞서 나가면서 충돌한 것입니다. 각 브랜치를 ${BASE} 기준으로 rebase 한 뒤"
  say "  다시 실행하거나, 해당 브랜치만 인자로 지정해 수동으로 얹으세요."
  say ""
  confirm "나머지만으로 ${STAGE} 를 갱신할까요?" || { say "중단했습니다. ${STAGE} 는 그대로입니다."; exit 1; }
fi

NEW_SHA="$(git -C "$WT" rev-parse HEAD)"

# ── §6. 안전장치③ force-with-lease 로 push ───────────────────────────────────
# 검사를 시작한 시점(§1)의 stage SHA 를 lease 로 건다. 그 사이 누가 stage 에 push 했다면
# 원격 값이 달라져 push 가 **거부**된다 — 남의 작업을 모르고 덮어쓰는 사고를 막는다.
say ""
say "▸ ${STAGE} 갱신 (${STAGE_SHA:0:8} → ${NEW_SHA:0:8})"
if ! git push --force-with-lease="${STAGE}:${STAGE_SHA}" "$REMOTE" "${NEW_SHA}:refs/heads/${STAGE}"; then
  say ""
  die "push 거부 — 검사 이후 누가 ${STAGE} 에 push 했습니다. 다시 실행하세요(백업 태그 ${TAG} 는 남아 있습니다)."
fi

say ""
say "✓ ${STAGE} 재조립 완료 — ${BASE}(${BASE_SHA:0:8}) 위에 ${MERGED}개 브랜치"
[[ ${#FAILED[@]} -gt 0 ]] && say "  (충돌로 빠짐: ${FAILED[*]})"
say "  백업 태그: ${TAG}"
say "  dev 게이트웨이는 다음 배포 때 이 ${STAGE} 를 가져갑니다."
