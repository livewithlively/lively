// #3546 — 재연결 예산이 **flap 에 닳는지** 못박는다.
//
// ── 왜 이 시험이 필요한가 ────────────────────────────────────────────────────
// 2026-09-04 매니지드 실측: 세션 컨테이너가 사라진 뒤 웹터미널이 16분간 멈추지 않고
//  `lvly tmux-relay: attach 실패: 409 {"message":"Container … is not running"}` 를 도배했다.
//  스크롤백까지 덮여 **죽기 직전 로그를 사람이 볼 수 없었다.**
//
// 기제: 컨테이너가 없어도 **게이트웨이까지는 정상적으로 붙는다.** 붙은 뒤 릴레이가 409 로 죽는다.
//  그런데 종전 코드는 `onopen` 에서 `attempts = 0` 으로 예산을 되돌렸다 — 즉 "붙었다"를
//  "연결이 섰다"의 증거로 삼았다. 그래서 「붙는다 → 예산 초기화 → 죽는다 → 재연결」이 영원히 돌았고,
//  40회 예산도 `giveUpReconnect` 도 **한 번도 도달하지 못했다.**
//
// 고침은 원인이 아니라 **부류**를 막는다: 예산은 «버틴 연결»만 되돌린다. 원인이 무엇이든
//  flap 은 예산을 쓰고, 다 쓰면 화면이 멈추고 결정권이 사람에게 간다.
//
// ── 왜 소스 텍스트로 보나 ───────────────────────────────────────────────────
// 이 상태(attempts·connProven·stableTimer)는 `connect()` 안의 클로저라 모듈에서 못 꺼낸다.
//  그리고 확인하려는 것은 값이 아니라 **배선**이다 — 「onopen 이 예산을 되돌리는가」.
//  같은 파일의 terminal-restore-gate.test.mjs 가 쓰는 방식 그대로다
//  (*"배선(무엇이 무엇을 부르는가)만 소스 텍스트로 확인한다"*).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(root, "web/standalone/terminal.ts"), "utf8");

let pass = 0;
const ok = (m) => { pass++; console.log(`ok  ${m}`); };

/** `sock.onopen = () => { … };` 본문만 잘라낸다(중괄호 깊이로 끝을 찾는다). */
function blockAfter(marker) {
  const i = src.indexOf(marker);
  assert.notEqual(i, -1, `소스에서 '${marker}' 를 못 찾았다 — 시험이 낡았다`);
  let depth = 0, started = false;
  for (let j = i; j < src.length; j++) {
    if (src[j] === "{") { depth++; started = true; }
    else if (src[j] === "}") { depth--; if (started && depth === 0) return src.slice(i, j + 1); }
  }
  assert.fail(`'${marker}' 의 블록 끝을 못 찾았다`);
}

const onopen = blockAfter("sock.onopen = () => {");

// ① ★ 회귀 그 자체 — onopen 이 예산을 되돌리면 무한 루프가 되살아난다.
assert.ok(!/\battempts\s*=\s*0\b/.test(onopen),
  "onopen 이 attempts 를 0 으로 되돌린다 — 붙자마자 죽는 판에서 예산이 영영 안 닳아 무한 재연결이 된다(#3546 회귀)");
ok("① onopen 은 재시도 예산(attempts)을 되돌리지 않는다");

assert.ok(!/\bgaveUp\s*=\s*false/.test(onopen),
  "onopen 이 gaveUp 을 되돌린다 — 포기 상태가 매 연결마다 취소돼 화면이 영원히 멈추지 않는다");
ok("② onopen 은 포기 상태(gaveUp)도 되돌리지 않는다");

// ③ 대신 «버팀» 을 확인한 뒤에 되돌린다.
assert.ok(/stableTimer\s*=\s*setTimeout\(\s*markConnProven/.test(onopen),
  "onopen 이 «버팀» 타이머를 걸지 않는다 — 그러면 정상 연결도 예산을 못 되돌려 멀쩡한 세션이 포기로 간다");
ok("③ onopen 은 예산 복구를 «버팀» 타이머(markConnProven)로 미룬다");

const proven = blockAfter("function markConnProven() {");
for (const [re, what] of [[/\battempts\s*=\s*0\b/, "attempts"], [/\bgaveUp\s*=\s*false/, "gaveUp"], [/\breconnectDelay\s*=\s*1500\b/, "reconnectDelay"]]) {
  assert.ok(re.test(proven), `markConnProven 이 ${what} 를 안 되돌린다 — 정상 재연결이 누적돼 결국 포기로 간다`);
}
ok("④ 버팀이 확인되면 attempts·gaveUp·reconnectDelay 를 되돌린다");

// ⑤ 0.4초 간격의 정체 — %exit 빠른 재판정은 «버틴 연결» 에만 준다.
//   안 그러면 붙자마자 죽는 판에서 reconnectDelay 가 매번 400 으로 되돌아가 백오프가 무력해진다.
assert.ok(/onExit:\s*\(\)\s*=>\s*\{\s*if\s*\(\s*connProven\s*\)\s*reconnectDelay\s*=\s*400/.test(src),
  "onExit 의 400ms 빠른 재판정이 connProven 게이트 없이 걸린다 — 0.4초 간격 무한 루프의 직접 원인이다");
ok("⑤ %exit 의 400ms 빠른 재판정은 버틴 연결에만 준다");

// ⑥ 증명 못 한 연결의 타이머는 close 에서 걷는다(안 걷으면 죽은 연결이 뒤늦게 예산을 되돌린다).
const onclose = blockAfter("sock.onclose = (e) => {");
assert.ok(/clearTimeout\(stableTimer\)/.test(onclose),
  "onclose 가 버팀 타이머를 안 걷는다 — 이미 죽은 연결이 10초 뒤에 예산을 되돌려 루프가 되살아난다");
ok("⑥ onclose 는 버팀 타이머를 걷는다");

// ⑦ 예산 자체가 살아 있는지(상한과 포기 경로가 그대로인지) — 위 배선의 전제다.
assert.ok(/const MAX_RECONNECT_ATTEMPTS = \d+/.test(src) && /attempts > MAX_RECONNECT_ATTEMPTS/.test(src),
  "재시도 상한 또는 그 검사가 사라졌다 — 예산이 닳아도 멈출 곳이 없다");
ok("⑦ 재시도 상한과 그 검사가 그대로 있다");

console.log(`\n${pass} passed`);
