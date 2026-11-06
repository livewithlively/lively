// #5398 — 터미널 첫 화면이 «연결 준비 중…» 에 말없이 서 있지 않는다.
//
//  왜(상민님 2026-11-02 신고): 그 글자는 첫 확인(/api/ui/me)의 답을 기다리는 동안만 뜨는데 시간 상한이 없었다. 평문 http 에서
//   브라우저 연결 한도(같은 주소 6개 · 모든 탭 공용)가 차면 그 요청이 대기열에서 안 나와 사람은 이유도 모른 채 멈춘 화면을 봤다.
//  사양 표(행마다 시험 하나 이상):
//   G1 늦을 때 말하는 것(순수 — 모듈을 그대로 import): http 면 연결 한도와 «탭을 닫으면 이어진다», 아니면 서버 응답.
//   G2 배선(소스 본문 — boot() 는 xterm 이 있어야 돌아 노드에서 실행할 수 없다):
//      · «연결 준비 중…» 다음, 첫 확인을 기다리기 **전에** 8초 타이머를 걸고, 답이 오면(성공이든 실패든) finally 에서 푼다.
//      · 늦어도 요청을 끊지 않는다(끊고 다시 보내면 대기열 맨 뒤로 간다) — 그 요청에 abort 신호가 없다.
//      · 401 · 403 만 로그인 카드. 그 밖의 실패 응답은 «닿지 못함»(응답 번호와 함께), 끊김(던짐)도 «닿지 못함».
//  수정 전 코드로 빨강을 보려면 TERMINAL_TS(소스) · TERMINAL_JS(tsc 산출 모듈)로 갈아 끼운다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { installBrowserStubs } from "./standalone-terminal-env.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = process.env.TERMINAL_TS || join(root, "web/standalone/terminal.ts");
const MOD = process.env.TERMINAL_JS || join(root, "dist/standalone/terminal.js");
const src = readFileSync(SRC, "utf8");
installBrowserStubs();
const T = await import(pathToFileURL(MOD).href);

let pass = 0;
const SOFT = process.env.SOFT_FAIL === "1";
let fails = 0;
const run = (name, fn) => {
  try { fn(); pass++; console.log(`ok  ${name}`); }
  catch (e) { if (!SOFT) throw e; fails++; console.log(`not ok  ${name} — ${String(e.message).split("\n")[0]}`); }
};

/** boot() 본문 — 다음 최상위 선언 전까지. */
function bootBody() {
  const m = /\nexport async function boot\(\) \{/.exec(src);
  assert.ok(m, "[배선] boot() 를 소스에서 찾았다");
  const rest = src.slice(m.index + m[0].length);
  const end = rest.search(/\n(?:export )?(?:async )?function /);
  return rest.slice(0, end < 0 ? undefined : end);
}

// ── G1 — 늦을 때 말하는 것 ─────────────────────────────────────────────────────
run("G1 배선: 판정 함수와 상한 값을 모듈에서 가져왔다", () => {
  assert.equal(typeof T.slowGateCopy, "function", "slowGateCopy 가 없다");
  assert.equal(T.ME_SLOW_MS, 8000, "첫 확인 상한은 8초다");
});
run("G1 http: — 연결 한도(6개)와 «쓰지 않는 탭을 닫으면 저절로 이어진다» 를 말한다", () => {
  const c = T.slowGateCopy("http:");
  assert.match(c.body, /6개/, "몇 개까지인지 말하지 않는다");
  assert.match(c.body, /탭/, "탭이 원인일 수 있다는 것을 말하지 않는다");
  assert.match(c.body, /닫으면 저절로 이어/, "무엇을 하면 풀리는지 말하지 않는다");
  assert.ok(c.title && !/…$/.test(c.title), "제목이 비었거나 말줄임으로 끝난다");
});
run("G1 https: · 빈 값 — 연결 한도를 말하지 않고(HTTP/2 는 그 한도가 없다) 서버 응답을 기다린다고 말한다", () => {
  for (const p of ["https:", "", undefined]) {
    const c = T.slowGateCopy(p);
    assert.doesNotMatch(c.body, /6개/, `${String(p)}: https 인데 연결 한도를 원인으로 말한다`);
    assert.match(c.title + c.body, /서버/, `${String(p)}: 무엇을 기다리는지 말하지 않는다`);
  }
});

// ── G2 — boot() 배선 ────────────────────────────────────────────────────────────
run("G2 «연결 준비 중…» 다음 · 첫 확인을 기다리기 전에 8초 타이머를 건다", () => {
  const b = bootBody();
  const iGate = b.indexOf("gate('연결 준비 중…');");
  const iTimer = b.search(/setTimeout\(gateSlow, ME_SLOW_MS\)/);
  const iMe = b.search(/await fetchAuth\('\/api\/ui\/me'\)/);
  assert.ok(iGate >= 0 && iTimer > iGate && iMe > iTimer, `순서가 틀렸다(gate ${iGate} · timer ${iTimer} · me ${iMe})`);
});
run("G2 답이 오면(성공 · 실패 · 던짐 모두) finally 에서 타이머를 푼다", () => {
  assert.match(bootBody(), /catch \(_\) \{ me = null; \}\s*\n\s*finally \{ clearTimeout\(slow\); \}/);
});
run("G2 늦어도 요청을 끊지 않는다 — 첫 확인 요청에 abort 신호를 싣지 않는다", () => {
  const b = bootBody();
  const line = b.slice(b.search(/await fetchAuth\('\/api\/ui\/me'/), b.search(/await fetchAuth\('\/api\/ui\/me'/) + 120);
  assert.doesNotMatch(line, /signal|AbortController/, line);
});
run("G2 401 · 403 만 로그인 카드 — 그 밖의 실패 응답은 «닿지 못함»(번호와 함께), 끊김도 «닿지 못함»", () => {
  const b = bootBody();
  assert.match(b, /if \(!me\) \{ gateUnreachable\(\); return; \}/, "끊김(던짐)을 «닿지 못함» 으로 말하지 않는다");
  assert.match(b, /if \(me\.status === 401 \|\| me\.status === 403\) \{ gateLogin\(\); return; \}/, "인증 거절만 로그인으로 보내지 않는다");
  assert.match(b, /if \(!me\.ok\) \{ gateUnreachable\(me\.status\); return; \}/, "그 밖의 실패 응답을 번호와 함께 말하지 않는다");
  //  종전 모양 — 첫 확인의 어떤 실패든 로그인 카드로 보냈다. 이것이 남아 있으면 위 갈래는 장식이다.
  assert.doesNotMatch(b, /await api\('\/api\/ui\/me'\);\s*\}\s*\n\s*catch \(_\) \{ gateLogin\(\); return; \}/, "종전처럼 모든 실패를 로그인으로 보낸다");
});
run("G2 늦은 카드는 다시 시도 단추를 준다 — 화면이 물음(이유)만 던지고 할 일을 안 주지 않는다", () => {
  const card = src.slice(src.indexOf("function gateCard("), src.indexOf("function gateSlow("));
  assert.match(card, /'다시 시도'/);
  assert.match(card, /location\.reload\(\)/);
});

console.log(`\n${pass}건 통과${fails ? ` · ${fails}건 실패` : ""}`);
process.exit(fails ? 1 : 0);
