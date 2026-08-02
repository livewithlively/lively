#!/usr/bin/env bash
# 훅 스크립트 stdin 픽스처 유닛테스트 러너 — 로컬 전용, 기본은 게이트웨이 무접촉.
#   bash hooks/test-hooks.sh            # 결정적 픽스처(게이트웨이 불필요)
#   LIVE=1 bash hooks/test-hooks.sh     # + 라이브 preload 케이스(게이트웨이/토큰 필요)
# 각 케이스: exit code / stdout / 플래그 파일 생성 여부를 assert. 실패 1건이라도 있으면 exit 1.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
# 스크립트와 동일 규칙: os.tmpdir()/lively-hooks (전 플랫폼 per-user tmp — 공유 /tmp 미사용)
FLAG_DIR="$(node -e 'process.stdout.write(require("node:path").join(require("node:os").tmpdir(),"lively-hooks"))')"
TMP_PARENT="$(dirname "$FLAG_DIR")"
PASS=0; FAIL=0

cleanup() { rm -f "$FLAG_DIR"/testsess* 2>/dev/null; }
ok()   { PASS=$((PASS+1)); echo "PASS $1"; }
bad()  { FAIL=$((FAIL+1)); echo "FAIL $1 — $2"; }

run() { # run <stdin> <script> [env...]  → 전역 OUT/CODE
  local stdin_data="$1" script="$2"; shift 2
  OUT=$(printf '%s' "$stdin_data" | env "$@" node "$HERE/$script" 2>/dev/null); CODE=$?
}

run_in() { # run_in <cwd> <stdin> <script> [env...]  → cwd 제어(자가 게이팅 테스트)
  local cwd="$1" stdin_data="$2" script="$3"; shift 3
  OUT=$(cd "$cwd" && printf '%s' "$stdin_data" | env "$@" node "$HERE/$script" 2>/dev/null); CODE=$?
}

# 자가 게이팅 stop-gate 는 'lively work' 세션에서만 작동 → 기존 stop 테스트는 cwd=$HERE 에서 돌리고
# work-root 도 $HERE 로 명시(cwd 가 work-root prefix 아래여야 게이트 켜짐).
GATE_ON="LIVELY_WORK_ROOTS=$HERE"

# ───────────────────────── session-preload ─────────────────────────
cleanup
run '' session-preload.mjs LIVELY_HOOKS_OFF=1
[ $CODE -eq 0 ] && [ -z "$OUT" ] && ok "preload① OFF(HOOKS_OFF alias) → exit0 무출력" || bad "preload① OFF" "code=$CODE out=$OUT"

run '' session-preload.mjs LIVELY_OFF=1
[ $CODE -eq 0 ] && [ -z "$OUT" ] && ok "preload①b OFF(LIVELY_OFF) → exit0 무출력" || bad "preload①b OFF" "code=$CODE out=$OUT"

TMPHOME=$(mktemp -d)
run '' session-preload.mjs HOME="$TMPHOME" LIVELY_TOKEN=
[ $CODE -eq 0 ] && [ -z "$OUT" ] && ok "preload② 토큰·정적 부재 → exit0 silent" || bad "preload② 토큰 부재" "code=$CODE out=$OUT"

# 정적 context.md 만 있고 토큰 없을 때 → 정적만 주입(라이브 스킵, fail-open)
mkdir -p "$TMPHOME/.lively"; printf '# STATIC-ORG-CTX\n정적컨텍스트내용\n' > "$TMPHOME/.lively/context.md"
run '' session-preload.mjs HOME="$TMPHOME" LIVELY_TOKEN=
[ $CODE -eq 0 ] && printf '%s' "$OUT" | grep -q 'STATIC-ORG-CTX' && ok "preload②b 정적만(토큰부재) → context.md 주입(raw=Claude)" || bad "preload②b 정적만" "code=$CODE out=${OUT:0:80}"

# Codex 모드(LIVELY_HARNESS=codex): 같은 정적 컨텍스트를 JSON 봉투로 — additionalContext 필드에 담겨야 한다.
run '' session-preload.mjs HOME="$TMPHOME" LIVELY_TOKEN= LIVELY_HARNESS=codex
if [ $CODE -eq 0 ] && printf '%s' "$OUT" | node -e '
  let s=""; process.stdin.on("data",c=>s+=c).on("end",()=>{
    try{const j=JSON.parse(s);
      const ac=j.hookSpecificOutput && j.hookSpecificOutput.additionalContext;
      const ev=j.hookSpecificOutput && j.hookSpecificOutput.hookEventName;
      process.exit(ev==="SessionStart" && typeof ac==="string" && ac.includes("STATIC-ORG-CTX")?0:1);
    }catch{process.exit(1)}});' ; then
  ok "preload②b-codex 정적만(codex) → JSON 봉투 additionalContext 에 주입"
else bad "preload②b-codex JSON 봉투" "code=$CODE out=${OUT:0:120}"; fi

# OFF 면 정적도 안 나간다(클린룸)
run '' session-preload.mjs HOME="$TMPHOME" LIVELY_TOKEN= LIVELY_OFF=1
[ $CODE -eq 0 ] && [ -z "$OUT" ] && ok "preload②c OFF → 정적도 미주입(클린룸)" || bad "preload②c OFF 정적" "out=${OUT:0:80}"
rm -rf "$TMPHOME"

# 게이트웨이 다운 케이스 — 깨끗한 HOME(정적 context.md 부재)으로 격리해 라이브 경로만 검증.
TMPHOME2=$(mktemp -d)
START=$(date +%s)
run '' session-preload.mjs HOME="$TMPHOME2" LIVELY_TOKEN=dummy LIVELY_GATEWAY_URL=http://127.0.0.1:1
ELAPSED=$(( $(date +%s) - START ))
[ $CODE -eq 0 ] && [ -z "$OUT" ] && [ $ELAPSED -le 3 ] && ok "preload③ 게이트웨이 다운(정적 부재) → exit0 silent ${ELAPSED}s" || bad "preload③ 게이트웨이 다운" "code=$CODE out=$OUT elapsed=${ELAPSED}s"
rm -rf "$TMPHOME2"

run 'this is not json {{{' session-preload.mjs LIVELY_HOOKS_OFF=1
[ $CODE -eq 0 ] && ok "preload⑤ 비JSON stdin 무해(미사용)" || bad "preload⑤ 비JSON stdin" "code=$CODE"

# ── 자산 sync 배선 자기치유(#742) — 배선 없는 기존 멤버: settings 배선 추가 + 러너 1회 실행 + reloadSkills 봉투 ──
#  게이트웨이 무접촉(죽은 GW 주소): 러너는 fail-open 즉시 종료, 배선/출력만 검증한다.
TMPHOME3=$(mktemp -d)
mkdir -p "$TMPHOME3/.lively/hooks" "$TMPHOME3/.claude"
cp "$HERE/sync-harness-assets.mjs" "$TMPHOME3/.lively/hooks/"
cat > "$TMPHOME3/.claude/settings.json" <<'EOF'
{"hooks":{"SessionStart":[{"matcher":"startup|resume|clear","hooks":[{"type":"command","command":"\"node\" \"$HOME/.lively/hooks/session-preload.mjs\""}]}]}}
EOF
run '' session-preload.mjs HOME="$TMPHOME3" LIVELY_TOKEN=dummy LIVELY_GATEWAY_URL=http://127.0.0.1:1
WIRED=$(grep -c 'sync-harness-assets' "$TMPHOME3/.claude/settings.json")
if [ $CODE -eq 0 ] && [ "$WIRED" = "1" ] && [ -f "$TMPHOME3/.claude/settings.json.bak-asset-wiring" ] && printf '%s' "$OUT" | grep -q '"reloadSkills":true'; then
  ok "preload⑥ 자기치유 — settings 배선 추가+백업+reloadSkills 봉투"
else bad "preload⑥ 자기치유" "code=$CODE wired=$WIRED out=${OUT:0:120}"; fi

run '' session-preload.mjs HOME="$TMPHOME3" LIVELY_TOKEN=dummy LIVELY_GATEWAY_URL=http://127.0.0.1:1
WIRED2=$(grep -c 'sync-harness-assets' "$TMPHOME3/.claude/settings.json")
if [ $CODE -eq 0 ] && [ "$WIRED2" = "1" ] && ! printf '%s' "$OUT" | grep -q 'reloadSkills'; then
  ok "preload⑥b 자기치유 멱등 — 재실행에 중복 배선·봉투 없음"
else bad "preload⑥b 자기치유 멱등" "code=$CODE wired=$WIRED2 out=${OUT:0:120}"; fi

TMPHOME4=$(mktemp -d)
mkdir -p "$TMPHOME4/.claude"
printf '{"hooks":{"SessionStart":[]}}\n' > "$TMPHOME4/.claude/settings.json"
run '' session-preload.mjs HOME="$TMPHOME4" LIVELY_TOKEN=dummy LIVELY_GATEWAY_URL=http://127.0.0.1:1
if [ $CODE -eq 0 ] && ! grep -q 'sync-harness-assets' "$TMPHOME4/.claude/settings.json"; then
  ok "preload⑥c 러너 파일 부재 → 배선 안 함(없는 파일 배선 금지)"
else bad "preload⑥c 러너 부재" "code=$CODE"; fi
rm -rf "$TMPHOME3" "$TMPHOME4"

# ── kit 훅 중복 dedup(#742) — 세대 드리프트로 중복 배선된 settings 를 세션 시작이 한 벌로 수렴 ──
#  구(무인용 node)+신("node") 두 벌 + 사용자 tmux 훅 공존 → kit 항목만 각 1개, 사용자 훅 보존, 멱등.
TMPHOME5=$(mktemp -d)
mkdir -p "$TMPHOME5/.lively/hooks" "$TMPHOME5/.claude"
cp "$HERE/sync-harness-assets.mjs" "$TMPHOME5/.lively/hooks/"
cat > "$TMPHOME5/.claude/settings.json" <<'EOF'
{"hooks":{"SessionStart":[
  {"matcher":"startup|resume|clear","hooks":[{"type":"command","command":"node \"$HOME/.lively/hooks/session-preload.mjs\""}]},
  {"matcher":"startup|resume|clear","hooks":[{"type":"command","command":"\"node\" \"$HOME/.lively/hooks/session-preload.mjs\""}]},
  {"matcher":"startup|resume|clear","hooks":[{"type":"command","command":"\"node\" \"$HOME/.lively/hooks/sync-harness-assets.mjs\""}]}],
"Stop":[
  {"hooks":[{"type":"command","command":"tmux display-message ok"}]},
  {"hooks":[{"type":"command","command":"node \"$HOME/.lively/hooks/run-custom.mjs\" Stop"}]},
  {"hooks":[{"type":"command","command":"\"node\" \"$HOME/.lively/hooks/run-custom.mjs\" Stop"}]}]}}
EOF
run '' session-preload.mjs HOME="$TMPHOME5" LIVELY_TOKEN=dummy LIVELY_GATEWAY_URL=http://127.0.0.1:1
SP_N=$(grep -c 'session-preload.mjs' "$TMPHOME5/.claude/settings.json")
RC_N=$(grep -c 'run-custom.mjs' "$TMPHOME5/.claude/settings.json")
SY_N=$(grep -c 'sync-harness-assets' "$TMPHOME5/.claude/settings.json")
TM_N=$(grep -c 'tmux display-message' "$TMPHOME5/.claude/settings.json")
KEPT_NEW=$(node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const c=s.hooks.SessionStart.flatMap(e=>e.hooks.map(h=>h.command)).filter(x=>x.includes("session-preload"));process.stdout.write(c.length===1&&c[0].startsWith("\"node\"")?"1":"0")' "$TMPHOME5/.claude/settings.json")
if [ $CODE -eq 0 ] && [ "$SP_N" = "1" ] && [ "$RC_N" = "1" ] && [ "$SY_N" = "1" ] && [ "$TM_N" = "1" ] && [ "$KEPT_NEW" = "1" ] && [ -f "$TMPHOME5/.claude/settings.json.bak-hook-dedup" ]; then
  ok "preload⑦ 훅 중복 dedup — kit 각 1개(뒤=최근 유지)·사용자 훅 보존·백업"
else bad "preload⑦ dedup" "code=$CODE sp=$SP_N rc=$RC_N sync=$SY_N tmux=$TM_N keptNew=$KEPT_NEW"; fi

cp "$TMPHOME5/.claude/settings.json" "$TMPHOME5/before2.json"
run '' session-preload.mjs HOME="$TMPHOME5" LIVELY_TOKEN=dummy LIVELY_GATEWAY_URL=http://127.0.0.1:1
if [ $CODE -eq 0 ] && cmp -s "$TMPHOME5/.claude/settings.json" "$TMPHOME5/before2.json"; then
  ok "preload⑦b dedup 멱등 — 재실행 무변경"
else bad "preload⑦b dedup 멱등" "code=$CODE (파일 변경됨)"; fi
rm -rf "$TMPHOME5"

if [ "${LIVE:-0}" = "1" ]; then
  run '' session-preload.mjs
  if [ $CODE -eq 0 ] && printf '%s' "$OUT" | grep -q '미매핑'; then
    if [ -n "${LIVELY_TOKEN:-}" ] && printf '%s' "$OUT" | grep -qF "$LIVELY_TOKEN"; then
      bad "preload④ 라이브" "출력에 토큰 문자열 포함!"
    else
      ok "preload④ 라이브 → '미매핑' 포함·토큰 미노출"
    fi
  else
    bad "preload④ 라이브" "code=$CODE out=${OUT:0:120}"
  fi
fi

# ───────────────────────── work-flag ─────────────────────────
cleanup
run '{"session_id":"testsess1","tool_name":"Write"}' work-flag.mjs
[ $CODE -eq 0 ] && [ -f "$FLAG_DIR/testsess1.worked" ] && ok "flag① Write → .worked" || bad "flag① Write" "code=$CODE flag=$([ -f $FLAG_DIR/testsess1.worked ] && echo y || echo n)"

# Codex 파일 편집 툴 apply_patch → .worked (하네스 무관 EDIT_TOOLS)
run '{"session_id":"testsess1b","tool_name":"apply_patch"}' work-flag.mjs
[ $CODE -eq 0 ] && [ -f "$FLAG_DIR/testsess1b.worked" ] && ok "flag①b apply_patch(Codex 편집) → .worked" || bad "flag①b apply_patch" "code=$CODE flag=$([ -f $FLAG_DIR/testsess1b.worked ] && echo y || echo n)"

run '{"session_id":"testsess2","tool_name":"mcp__lively__activity_log"}' work-flag.mjs
[ $CODE -eq 0 ] && [ -f "$FLAG_DIR/testsess2.writeback" ] && [ -f "$FLAG_DIR/testsess2.lively" ] && ok "flag② mcp activity_log → .writeback + .lively" || bad "flag② mcp write" "code=$CODE"

run '{"session_id":"testsess3","tool_name":"mcp__lively__search_items"}' work-flag.mjs
[ $CODE -eq 0 ] && [ ! -e "$FLAG_DIR/testsess3.writeback" ] && [ ! -e "$FLAG_DIR/testsess3.worked" ] && [ -f "$FLAG_DIR/testsess3.lively" ] && ok "flag③ 읽기툴 → .lively만(writeback/worked 없음)" || bad "flag③ 읽기툴" "writeback/worked 누수 또는 .lively 부재"

run '{"session_id":"../evil","tool_name":"Write"}' work-flag.mjs
[ $CODE -eq 0 ] && [ ! -e "$TMP_PARENT/evil.worked" ] && [ ! -e "$FLAG_DIR/../evil.worked" ] && ok "flag④ 경로조작 sid → no-op" || bad "flag④ 경로조작" "code=$CODE"

run '{"session_id":"testsess5","tool_name":"Write"}' work-flag.mjs LIVELY_HOOKS_OFF=1
[ $CODE -eq 0 ] && [ ! -e "$FLAG_DIR/testsess5.worked" ] && ok "flag⑤ OFF(alias) → 플래그 미생성" || bad "flag⑤ OFF" "flag created"

run '{"session_id":"testsess5b","tool_name":"Write"}' work-flag.mjs LIVELY_OFF=1
[ $CODE -eq 0 ] && [ ! -e "$FLAG_DIR/testsess5b.worked" ] && ok "flag⑤b OFF(LIVELY_OFF) → 플래그 미생성" || bad "flag⑤b OFF" "flag created"

run 'garbage!!!' work-flag.mjs
[ $CODE -eq 0 ] && ok "flag⑥ 쓰레기 stdin → exit0" || bad "flag⑥ 쓰레기 stdin" "code=$CODE"

run '{"session_id":"testsess7","tool_name":"mcp__lively__knowledge_save"}' work-flag.mjs
[ $CODE -eq 0 ] && [ -f "$FLAG_DIR/testsess7.writeback" ] && ok "flag⑦ mcp knowledge_save → .writeback" || bad "flag⑦ knowledge_save" "code=$CODE"

# 비-lively MCP 쓰기 툴 suffix → writeback(서버 무관) 이지만 .lively 는 안 붙음
run '{"session_id":"testsess8","tool_name":"mcp__other__activity_log"}' work-flag.mjs
[ $CODE -eq 0 ] && [ -f "$FLAG_DIR/testsess8.writeback" ] && [ ! -e "$FLAG_DIR/testsess8.lively" ] && ok "flag⑧ 비-lively MCP 쓰기 → .writeback, .lively 없음" || bad "flag⑧ 비-lively" "code=$CODE"

# ───────────────────────── stop-writeback-gate ─────────────────────────
cleanup
mkdir -p "$FLAG_DIR"; touch "$FLAG_DIR/testsessA.worked"
run_in "$HERE" '{"session_id":"testsessA","stop_hook_active":true}' stop-writeback-gate.mjs "$GATE_ON"
[ $CODE -eq 0 ] && [ -z "$OUT" ] && ok "stop① stop_hook_active → exit0 무출력(필수)" || bad "stop① loop guard" "code=$CODE out=$OUT"

touch "$FLAG_DIR/testsessB.worked"
run_in "$HERE" '{"session_id":"testsessB","stop_hook_active":false}' stop-writeback-gate.mjs "$GATE_ON"
if [ $CODE -eq 0 ] && [ -f "$FLAG_DIR/testsessB.blocked" ] && printf '%s' "$OUT" | python3 -m json.tool >/dev/null 2>&1 && printf '%s' "$OUT" | grep -q '"decision": *"block"'; then
  ok "stop② worked만(work-root) → decision:block(JSON 유효) + .blocked"
else bad "stop② block" "code=$CODE out=${OUT:0:80}"; fi

run_in "$HERE" '{"session_id":"testsessB","stop_hook_active":false}' stop-writeback-gate.mjs "$GATE_ON"
[ $CODE -eq 0 ] && [ -z "$OUT" ] && ok "stop③ blocked 존재 → 통과(세션당 1회)" || bad "stop③ once" "out=$OUT"

run_in "$HERE" '{"session_id":"testsessC","stop_hook_active":false}' stop-writeback-gate.mjs "$GATE_ON"
[ $CODE -eq 0 ] && [ -z "$OUT" ] && ok "stop④ 플래그 전무 → 통과(작업 없음)" || bad "stop④ no work" "out=$OUT"

touch "$FLAG_DIR/testsessD.worked" "$FLAG_DIR/testsessD.writeback"
run_in "$HERE" '{"session_id":"testsessD","stop_hook_active":false}' stop-writeback-gate.mjs "$GATE_ON"
[ $CODE -eq 0 ] && [ -z "$OUT" ] && ok "stop⑤ worked+writeback → 통과(기록 완료)" || bad "stop⑤ writeback" "out=$OUT"

touch "$FLAG_DIR/testsessE.worked"
run_in "$HERE" '{"session_id":"testsessE","stop_hook_active":false}' stop-writeback-gate.mjs "$GATE_ON" LIVELY_HOOKS_OFF=1
[ $CODE -eq 0 ] && [ -z "$OUT" ] && ok "stop⑥ OFF(alias) → exit0" || bad "stop⑥ OFF" "out=$OUT"

touch "$FLAG_DIR/testsessE2.worked"
run_in "$HERE" '{"session_id":"testsessE2","stop_hook_active":false}' stop-writeback-gate.mjs "$GATE_ON" LIVELY_OFF=1
[ $CODE -eq 0 ] && [ -z "$OUT" ] && ok "stop⑥b OFF(LIVELY_OFF) → exit0" || bad "stop⑥b OFF" "out=$OUT"

run 'not json' stop-writeback-gate.mjs "$GATE_ON"
[ $CODE -eq 0 ] && [ -z "$OUT" ] && ok "stop⑦ 쓰레기 stdin → exit0" || bad "stop⑦ garbage" "code=$CODE"

# ── 자가 게이팅 (D4) ──
# 밖(work-root 아님, .lively 없음): worked 있어도 침묵 — /tmp 에서 실행, work-root 미지정
touch "$FLAG_DIR/testsessG.worked"
GATE_OUT_DIR="$(mktemp -d)"
run_in "$GATE_OUT_DIR" '{"session_id":"testsessG","stop_hook_active":false}' stop-writeback-gate.mjs LIVELY_WORK_ROOTS=
[ $CODE -eq 0 ] && [ -z "$OUT" ] && [ ! -e "$FLAG_DIR/testsessG.blocked" ] && ok "stop⑧ 자가게이팅 밖 → 침묵(.blocked 미생성)" || bad "stop⑧ 게이팅 밖" "code=$CODE out=${OUT:0:80}"
rmdir "$GATE_OUT_DIR" 2>/dev/null

# 밖이지만 .lively 신호 있음 → 작동(lively-touch 가 cwd 무시하고 게이트 켬)
touch "$FLAG_DIR/testsessH.worked" "$FLAG_DIR/testsessH.lively"
GATE_OUT_DIR2="$(mktemp -d)"
run_in "$GATE_OUT_DIR2" '{"session_id":"testsessH","stop_hook_active":false}' stop-writeback-gate.mjs LIVELY_WORK_ROOTS=
[ $CODE -eq 0 ] && [ -f "$FLAG_DIR/testsessH.blocked" ] && printf '%s' "$OUT" | grep -q '"decision":"block"' && ok "stop⑨ .lively 신호 → 밖이어도 게이트 작동" || bad "stop⑨ lively-touch" "code=$CODE out=${OUT:0:80}"
rmdir "$GATE_OUT_DIR2" 2>/dev/null

# stdin cwd 필드가 process.cwd() 보다 우선(하네스 무관 계약 — Codex R2 drop-in).
#   /tmp 에서 실행하지만 stdin.cwd 를 work-root($HERE) 로 주면 게이트가 켜져야 한다.
touch "$FLAG_DIR/testsessI.worked"
GATE_OUT_DIR3="$(mktemp -d)"
run_in "$GATE_OUT_DIR3" "{\"session_id\":\"testsessI\",\"stop_hook_active\":false,\"cwd\":\"$HERE\"}" stop-writeback-gate.mjs LIVELY_WORK_ROOTS=
[ $CODE -eq 0 ] && [ -f "$FLAG_DIR/testsessI.blocked" ] && printf '%s' "$OUT" | grep -q '"decision":"block"' && ok "stop⑩ stdin cwd(work-root) → 게이트 작동(process.cwd 무시)" || bad "stop⑩ stdin cwd" "code=$CODE out=${OUT:0:80}"
rmdir "$GATE_OUT_DIR3" 2>/dev/null

# 역: cwd=$HERE 에서 실행하지만 stdin.cwd 를 work-root 밖으로 주면 침묵(stdin 이 우선).
touch "$FLAG_DIR/testsessJ.worked"
run_in "$HERE" "{\"session_id\":\"testsessJ\",\"stop_hook_active\":false,\"cwd\":\"/tmp\"}" stop-writeback-gate.mjs "LIVELY_WORK_ROOTS=$HERE"
[ $CODE -eq 0 ] && [ -z "$OUT" ] && [ ! -e "$FLAG_DIR/testsessJ.blocked" ] && ok "stop⑪ stdin cwd(밖) → 침묵(process.cwd=work-root 무시)" || bad "stop⑪ stdin cwd 밖" "code=$CODE out=${OUT:0:80}"

# 병렬 중복 등록 가드(#270 회귀) — 같은 Stop 이벤트에 훅이 유저+프로젝트 settings 양쪽에서 등록되면
#   클코가 병렬 실행한다. .blocked 원자 점유(O_EXCL)가 없으면 둘 다 block → 너지 N회('여러번 뜨는' 버그).
#   같은 session_id 로 2개를 동시에 띄워 여러 라운드 돌려, 라운드당 block 출력이 정확히 1회인지 검증.
RACE_FAIL=0
for r in 1 2 3 4 5 6 7 8; do
  rm -f "$FLAG_DIR/testsessK".*
  touch "$FLAG_DIR/testsessK.worked" "$FLAG_DIR/testsessK.lively"
  RIN="{\"session_id\":\"testsessK\",\"stop_hook_active\":false}"
  R1="$FLAG_DIR/testsessK.o1"; R2="$FLAG_DIR/testsessK.o2"
  ( cd "$HERE" && printf '%s' "$RIN" | env "LIVELY_WORK_ROOTS=$HERE" node "$HERE/stop-writeback-gate.mjs" >"$R1" 2>/dev/null ) &
  ( cd "$HERE" && printf '%s' "$RIN" | env "LIVELY_WORK_ROOTS=$HERE" node "$HERE/stop-writeback-gate.mjs" >"$R2" 2>/dev/null ) &
  wait
  n=0; [ -s "$R1" ] && n=$((n+1)); [ -s "$R2" ] && n=$((n+1))
  [ "$n" -ne 1 ] && RACE_FAIL=$((RACE_FAIL+1))
done
rm -f "$FLAG_DIR/testsessK".*
[ "$RACE_FAIL" -eq 0 ] && ok "stop⑫ 병렬 2회 동시실행 → block 정확히 1회(원자 .blocked, 8라운드)" || bad "stop⑫ 병렬 중복 너지" "$RACE_FAIL/8 라운드에서 block≠1"

cleanup
echo
echo "결과: PASS=$PASS FAIL=$FAIL"
[ $FAIL -eq 0 ]
