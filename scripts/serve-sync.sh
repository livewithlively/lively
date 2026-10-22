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
#   LIVELY_SERVE_RETRY_SEC=0 scripts/serve-sync.sh   # 밀린 단계(실패한 빌드·재시작)를 지금 바로 다시 시도
#   launchd io.lvly.stage-sync 가 주기 실행한다(deploy/io.lvly.stage-sync.plist).
set -uo pipefail

CLONE="${LIVELY_SERVE_CLONE:-/Users/lively/.openclaw/workspace/productivity/lively}"
BRANCH="${LIVELY_SERVE_BRANCH:-stage}"
CHECK_ONLY=0
[ "${1:-}" = "--check" ] && CHECK_ONLY=1

say() { printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*"; }

# ── 상태를 **밖에서 보이게** 남긴다 (#2116) ───────────────────────────────────
#  건너뛰는 것 자체는 옳다(남의 WIP 를 안 지운다). 문제는 **그 사실이 로그에만 남는 것**이었다 —
#  2026-08-26 실측: 하루 세 번, 22분·15분씩 dev 가 옛 화면을 서빙하는 동안 아무도 몰랐다.
#  게이트웨이 /readyz 가 이 파일을 읽어 degraded 로 드러낸다(src/ops/stage-sync-status.ts).
#  ⚠ 사유는 **거친 분류만** 싣는다 — /readyz 는 미인증이라 원문 메시지(남의 브랜치·파일명)를 내보내지 않는다.
STATUS="$CLONE/logs/stage-sync.status"
now_iso() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }
status_field() { # $1=키 — 셸 내장만 쓴다(틱마다 여러 번 불린다)
  [ -f "$STATUS" ] || return 1
  local l re="\"$1\":\"([^\"]*)\""; l=$(<"$STATUS")
  [[ $l =~ $re ]] && printf '%s' "${BASH_REMATCH[1]}"
}
# 같은 상태(skipped·failed)가 이어지면 시작 시각을 이어 간다 — 매번 새로 찍으면 '얼마나 오래 막혔나'를 영영 모른다.
prev_since() { [ "$(status_field state)" = "$1" ] && status_field since; }
write_status() { # $1=state(synced|skipped|failed) $2=code
  mkdir -p "$(dirname "$STATUS")" 2>/dev/null || return 0
  local n s; n="$(now_iso)"; s=""
  [ "$1" = "synced" ] || { s="$(prev_since "$1")"; [ -n "$s" ] || s="$n"; }
  printf '{"at":"%s","state":"%s","code":"%s","since":"%s"}\n' "$n" "$1" "${2:-}" "${s:-$n}" > "$STATUS" 2>/dev/null || true
}

skip() { # $1=거친 사유 코드, 나머지=사람 말
  local code="$1"; shift
  [ $CHECK_ONLY -eq 1 ] || write_status skipped "$code"
  say "건너뜀 — $*"; exit 0
}   # 정상 종료: 이 스크립트가 손대면 안 되는 상태라는 뜻이다

# 당긴 커밋은 들어왔는데 서빙이 못 따라갔다(#4814) — **synced 라 말하지 않는다.** 종전엔 여기서 상태를 안 쓰고
#  exit 1 만 해서 앞 틱의 synced 가 남았고, 다음 틱은 «이미 최신» 경로로 빠져 synced 를 다시 찍었다.
#  2026-10-16 실측: stage 의 tsc 깨짐으로 03:28 부터 13시간 재시작이 실패했는데 /readyz 는 내내 synced 였다.
fail() { # $1=거친 사유 코드, 나머지=사람 말
  local code="$1"; shift
  write_status failed "$code"
  say "⚠ $*"; exit 1
}

# ── 의존성 — package-lock 이 바뀌면 설치한다 (#4685) ──────────────────────────────────────
#  종전엔 이 단계가 없어 **새 의존성이 dev 에 영영 안 깔렸다**. 2026-10-14 실측: mermaid(devDependencies — build:web 이
#  node_modules 에서 public/app/vendor 로 복사한다)를 stage 에 올리자 :8080 이 lib/mermaid.js 는 새 판을 내면서
#  vendor/mermaid/mermaid.min.js 는 404 를 냈다 — 본문의 mermaid 가 그림 대신 «도구를 불러오지 못해» 로 떨어졌다.
#  · 커밋 diff 가 아니라 «마지막으로 설치한 lock 의 지문»(logs/deps.lock-sha)과 지금 lock 을 견준다 — 이 단계가 생기기
#    전에 이미 당겨 온 변경도 다음 틱에 잡히고, 설치가 실패하면 다음 틱에 다시 시도한다(지문은 성공했을 때만 적는다).
#  · `npm ci` 가 아니라 `npm install --no-save` — ci 는 node_modules 를 통째로 지우고 다시 깐다. 그 사이 돌고 있는
#    게이트웨이가 늦게 부르는 모듈(동적 import)을 못 찾는다. install 은 모자란 것·다른 것만 고친다. --no-save 라
#    package.json·lock 을 고치지 않는다(고치면 이 클론이 dirty 가 돼 다음 동기화가 «남의 WIP» 로 읽고 멈춘다).
#  · 설치했으면 웹을 다시 빌드하고(벤더 복사) 게이트웨이도 다시 띄운다 — 런타임 의존성이 바뀐 것이면 재시작 전까지
#    옛 판이 돈다. 과잉 재시작은 몇 초로 무해하고 누락은 조용한 버그다(아래 src·kit 판정과 같은 원칙).
LOCK_STAMP="$CLONE/logs/deps.lock-sha"
DEPS_CHANGED=0
lock_sha() { { shasum -a 256 "$CLONE/package-lock.json" 2>/dev/null || sha256sum "$CLONE/package-lock.json" 2>/dev/null; } | cut -d' ' -f1; }
sync_deps() {
  local want have
  want=$(lock_sha)
  [ -n "$want" ] || return 0
  have=$(cat "$LOCK_STAMP" 2>/dev/null || true)
  [ "$want" = "$have" ] && return 0
  say "의존성(package-lock) 변경 — npm install"
  ( cd "$CLONE" && npm install --no-save --no-audit --no-fund >/dev/null 2>&1 ) \
    || fail deps "npm install 실패 — 새 의존성 없이 돈다(다음 틱에 다시 시도한다 · 사람이 봐야 한다)"
  mkdir -p "$(dirname "$LOCK_STAMP")" 2>/dev/null
  printf '%s\n' "$want" > "$LOCK_STAMP"
  DEPS_CHANGED=1
}
build_web() {
  say "build:web"
  ( cd "$CLONE" && rm -f .tsbuildinfo-web && npm run build:web >/dev/null 2>&1 ) \
    || fail web "build:web 실패 — 옛 산출물이 그대로 서빙된다(사람이 봐야 한다)"
}
build_standalone() {
  say "build-standalone"
  ( cd "$CLONE" && node scripts/build-standalone.mjs >/dev/null 2>&1 ) \
    || fail standalone "build-standalone 실패 — terminal.js 등 옛 산출물이 그대로 서빙된다(사람이 봐야 한다)"
}
restart_gateway() {
  say "restart-gateway.sh"
  ( cd "$CLONE" && scripts/restart-gateway.sh >/dev/null 2>&1 ) \
    || fail restart "게이트웨이 재시작 실패 — 기존 프로세스는 그대로 살아 있다"
}

# ── 밀린 단계 (#4814) ─────────────────────────────────────────────────────────────────────
#  당긴 뒤 web·standalone·restart 중 하나가 실패하면 그 단계는 **다음 틱으로 넘어가야** 한다. 종전엔 실패하면
#  그냥 끝났고, 다음 틱은 이미 최신이라 아무것도 안 했다 — 실패 뒤 들어온 커밋이 src 를 안 건드리면 재시작은 영영 없었다.
#  · 당긴 직후, 하기 **전에** 적는다 — 어느 단계에서 멈춰도 남는다. 끝낸 단계만 지운다. 비면 파일을 지운다.
#  · 새 커밋이 오면 그 커밋이 요구하는 단계와 **합쳐서** 한다.
#  · 새 커밋이 없으면 마지막 시도 뒤 RETRY_SEC 가 지났을 때만 다시 한다 — 깨진 빌드를 1분마다 다시 빌드하지 않는다.
#    그 사이 틱은 failed 를 다시 찍는다(시작 시각은 이어 간다). 안 찍으면 /readyz 가 «잡이 죽었다(stale)» 로 오판한다.
#    지금 바로 다시: LIVELY_SERVE_RETRY_SEC=0 scripts/serve-sync.sh
#  · 시도 시각은 이 파일의 mtime 이다 — 시도를 시작할 때 touch 한다.
PENDING="$CLONE/logs/stage-sync.pending"
RETRY_SEC="${LIVELY_SERVE_RETRY_SEC:-900}"
STEP_ORDER="web standalone restart"   # 하는 순서이자 적는 순서 — 웹 산출물이 서야 새 게이트웨이가 그걸 서빙한다
pending_list() { [ -f "$PENDING" ] || return 0; local l; l=$(<"$PENDING"); set -- $l; printf '%s' "$*"; }   # 공백·줄바꿈을 한 칸으로
pending_has() { case " $(pending_list) " in *" $1 "*) return 0 ;; esac; return 1; }
pending_any() { [ -n "$(pending_list)" ]; }   # 파일 크기가 아니라 내용으로 — 빈 줄만 있는 파일은 «밀린 것 없음»이다
pending_set() { # $@=남은 단계(STEP_ORDER 순으로 다시 적는다)
  local s cur=" $* " out=""
  for s in $STEP_ORDER; do case "$cur" in *" $s "*) out="${out:+$out }$s" ;; esac; done
  if [ -z "$out" ]; then rm -f "$PENDING"; return 0; fi
  mkdir -p "$(dirname "$PENDING")" 2>/dev/null
  printf '%s\n' "$out" > "$PENDING"
}
pending_add() { pending_set $(pending_list) "$@"; }
pending_done() { local s keep=""; for s in $(pending_list); do [ "$s" = "$1" ] || keep="$keep $s"; done; pending_set $keep; }
pending_age() { # 마지막 시도 뒤 지난 초(파일이 없으면 아주 큰 값). LIVELY_SERVE_NOW(epoch 초)는 시험이 시계를 고정하는 자리다
  local m; m=$(stat -c %Y "$PENDING" 2>/dev/null || stat -f %m "$PENDING" 2>/dev/null) || { echo 999999999; return; }
  echo $(( ${LIVELY_SERVE_NOW:-$(date +%s)} - m ))
}
run_pending() { # 실패하면 fail 이 그 자리에서 끝낸다 — 남은 단계는 파일에 그대로 있다
  pending_any || return 0
  touch "$PENDING"
  if pending_has web; then build_web; pending_done web; fi
  if pending_has standalone; then build_standalone; pending_done standalone; fi
  if pending_has restart; then restart_gateway; pending_done restart; fi
}

[ -d "$CLONE/.git" ] || { say "오류: 서빙 클론이 아니다 — $CLONE"; exit 1; }
git -C "$CLONE" rev-parse --git-dir >/dev/null 2>&1 || { say "오류: git 레포가 아니다 — $CLONE"; exit 1; }

cur=$(git -C "$CLONE" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "?")
[ "$cur" = "$BRANCH" ] || skip branch "체크아웃이 $BRANCH 가 아니다(현재 $cur) — 사람이 무언가 하는 중일 수 있다"

# ── 손대면 안 되는 상태 넷 ─────────────────────────────────────────────────────
git -C "$CLONE" rev-parse -q --verify MERGE_HEAD >/dev/null 2>&1 && skip merging "머지 진행 중(MERGE_HEAD)"
[ -n "$(git -C "$CLONE" ls-files -u 2>/dev/null)" ] && skip conflict "미해소 충돌(unmerged)이 있다"
for d in rebase-merge rebase-apply CHERRY_PICK_HEAD; do
  [ -e "$CLONE/.git/$d" ] && skip procedure "$d 진행 중"
done
# ⚠ **추적되는 파일의 변경만** 막는다. untracked 는 통과시킨다 —
#  그 클론엔 프로토타입 파일(public/onboarding-proto/*.html 등)이 늘 하나씩 놓여 있어서,
#  untracked 까지 세면 그 파일 하나 때문에 동기화가 **영영** 멈춘다(첫 판에 실제로 그랬다).
#  untracked 가 들어올 커밋과 부딪히면 아래 `merge --ff-only` 가 스스로 거부하므로 안전은 git 이 지킨다.
# ⚠ **stat 만 어긋난 «가짜 dirty» 를 먼저 턴다** — 내용은 같은데 파일이 touch 되면(빌드·rsync·에디터 저장)
#  git 이 그 파일을 M 으로 보고, 이 잡은 «남의 WIP» 로 읽어 영영 건너뛴다. 2026-08-31 실측: 그 상태로
#  22분간 dev 가 옛 화면을 서빙했고 세 세션의 커밋이 함께 막혔다(내용 차이는 0이었다).
#  refresh 는 **내용이 같은 항목만** 인덱스에 다시 도장 찍는다 — 진짜 변경은 그대로 남아 아래 판정에 걸린다.
git -C "$CLONE" update-index -q --refresh >/dev/null 2>&1 || true
dirty=$(git -C "$CLONE" status --porcelain --untracked-files=no 2>/dev/null)
[ -n "$dirty" ] && skip dirty "추적 파일에 변경이 있다(남의 WIP 일 수 있다):
$(printf '%s\n' "$dirty" | head -10 | sed 's/^/    /')"

git -C "$CLONE" fetch -q origin "$BRANCH" || { say "오류: fetch 실패"; exit 1; }
local_sha=$(git -C "$CLONE" rev-parse HEAD)
remote_sha=$(git -C "$CLONE" rev-parse "origin/$BRANCH")
# ⚠ 이미 최신인 평상시 경로에서도 **살아 있다는 도장을 찍는다** — 안 찍으면 잡이 멀쩡히 도는데도
#  상태 파일이 늙어 /readyz 가 'stale(잡 사망)' 로 오판한다. 대부분의 틱이 이 경로로 끝난다.
if [ "$local_sha" = "$remote_sha" ]; then
  if [ $CHECK_ONLY -eq 1 ]; then
    say "최신 — ${local_sha:0:8}"
    [ "$(lock_sha)" = "$(cat "$LOCK_STAMP" 2>/dev/null)" ] || say "의존성 설치 필요(package-lock 지문이 마지막 설치와 다르다)"
    pending_any && say "밀린 단계 — $(pending_list) (마지막 시도 $(pending_age)초 전 · ${RETRY_SEC}초마다 다시 시도)"
    exit 0
  fi
  #  커밋은 그대로여도 의존성은 따로 본다 — 이 단계가 생기기 전에 당겨 온 lock 변경을 여기서 잡는다(위 «의존성» 절).
  sync_deps
  if [ $DEPS_CHANGED -eq 1 ]; then
    say "의존성을 깔았다 — build:web · restart-gateway.sh"
    pending_add web restart
  elif pending_any; then
    #  밀린 단계가 있다(위 «밀린 단계» 절). 간격 전이면 다시 돌리지 않고 실패를 다시 찍기만 한다 — 사유는 맨 앞 단계다
    #  (순서대로 하다 거기서 멈췄으므로).
    if [ "$(pending_age)" -lt "$RETRY_SEC" ]; then
      set -- $(pending_list)
      write_status failed "${1:-unknown}"
      exit 0
    fi
    say "밀린 단계 다시 시도 — $(pending_list)"
  fi
  run_pending
  write_status synced ""
  exit 0
fi

# 미푸시 커밋이 있으면 그 사람이 아직 올리지 않은 것이다 — 앞질러 가지 않는다.
ahead=$(git -C "$CLONE" rev-list --count "origin/$BRANCH..HEAD")
[ "$ahead" -gt 0 ] && skip unpushed "미푸시 커밋 ${ahead}개가 있다(남의 작업을 대신 공개하지 않는다)"

behind=$(git -C "$CLONE" rev-list --count "HEAD..origin/$BRANCH")
if [ $CHECK_ONLY -eq 1 ]; then say "동기화 필요 — ${behind}커밋 뒤짐(${local_sha:0:8} → ${remote_sha:0:8})"; exit 0; fi

say "동기화 — ${behind}커밋 (${local_sha:0:8} → ${remote_sha:0:8})"
git -C "$CLONE" merge --ff-only "origin/$BRANCH" >/dev/null || fail ff "ff 실패(히스토리가 갈렸거나 미추적 파일이 부딪힌다) — 사람이 봐야 한다"

# 이 커밋들이 요구하는 단계를 **하기 전에** 밀린 단계로 적는다(위 «밀린 단계» 절) — 앞서 밀린 것과 합쳐진다.
need=""
# 웹 산출물은 git 밖이므로(#2054) 받은 소스로 **여기서** 다시 만든다. 안 만들면 :8080 이 옛 화면을 서빙한다.
git -C "$CLONE" diff --quiet "$local_sha" HEAD -- web/ public/styles/ 2>/dev/null || need="$need web"
# 단독 페이지 번들(public/terminal.js·md.js·page-scrollbar.js)은 build:web 이 안 만든다 — 별 파이프라인(#1313 R51,
#  scripts/build-standalone.mjs)이다. 종전엔 여기서 안 돌려 **web/standalone/ 변경이 dev 에 영영 안 나갔다**
#  (#3784 실측 2026-09-09: 터미널 우클릭 메뉴를 stage 에 올렸는데 olddev 의 terminal.js 는 옛 판 그대로).
git -C "$CLONE" diff --quiet "$local_sha" HEAD -- web/standalone/ scripts/build-standalone.mjs 2>/dev/null || need="$need standalone"

# src/** 가 바뀌었으면 게이트웨이가 새 코드를 들어야 한다. 빌드 실패면 restart-gateway.sh 가 스스로 멈춘다.
#
# ⚠ `kit/**` 도 함께 본다(#2621). 대부분의 kit 변경은 재시작이 **불요**하다 — 게이트웨이는 설치 번들을
#  조립할 때마다 `kitAbs()` 로 **그 순간 디스크의 kit 파일**을 읽으므로(`kitVersion()` 60초 캐시,
#  `/install` 은 캐시조차 없음) 여기서 당기기만 하면 최대 60초 뒤 반영된다.
#  하지만 **조립기 자신은 다르다**: `src/org/delivery/publish.ts` 가 `kit/generator/build-context.mjs` 를
#  `await import()` 로 로드하는데 **ESM 모듈 캐시는 프로세스 생애 동안 유지된다.** 그 파일이 바뀌어도
#  재시작 전까지 옛 조립 로직이 돌고, 키트 번들이 조용히 낡는다(kit_version 이 안 움직이니 멤버 자동
#  업데이트도 안 걸린다 — 아무도 눈치채지 못한다).
#  그 캐시는 build-context.mjs 가 **정적 import 하는 것들에도** 걸린다(지금은 `kit/setup/kit-manifest.mjs`).
#  그래서 경로를 하나씩 세지 않는다 — import 가 하나 늘 때마다 여기가 조용히 낡기 때문이다.
#  대신 kit/ 전체를 보고 **테스트 파일만 뺀다**: 과잉 재시작은 몇 초로 무해하지만, 누락은 조용한 버그다.
git -C "$CLONE" diff --quiet "$local_sha" HEAD -- src/ kit/ ':(exclude)kit/**/*.test.mjs' 2>/dev/null || need="$need restart"
carried="$(pending_list)"
[ -n "$carried" ] && say "밀린 단계 이어받음 — $carried"
pending_add $need

# 의존성 먼저 — 웹 빌드가 node_modules 에서 벤더를 복사하므로 빌드보다 앞서야 한다(위 «의존성» 절).
#  설치가 실패해도 위에 적은 단계는 남는다 — 다음 틱이 설치를 다시 시도하고 이어서 한다.
sync_deps
[ $DEPS_CHANGED -eq 1 ] && pending_add web restart
run_pending

code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 localhost:8080/healthz 2>/dev/null); [ -n "$code" ] || code="000"
say "완료 — HEAD ${remote_sha:0:8} · healthz $code"
# ⚠ healthz 가 200 이 아니면 **동기화는 됐는데 게이트웨이가 못 서고 있다**는 뜻이다. 조용히 넘기지 않는다 —
#  이 잡이 성공으로 끝나면 아무도 안 본다(로그는 no-op 일 때 비어 있어서 사람이 들여다볼 이유가 없다).
#  상태도 synced 가 아니다(#4814 — 종전엔 synced 를 먼저 쓰고 실패로 끝났다).
[ "$code" = "200" ] || fail healthz "healthz=$code — dev 가 응답하지 않는다(사람이 봐야 한다)"
write_status synced ""
