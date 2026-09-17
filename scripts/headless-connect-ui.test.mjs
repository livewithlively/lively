// «사람 없이 도는 작업» 자격을 화면에서 연결하는 자리의 **배선 계약** (#4051) — 소스를 읽어 검사한다.
//
//  화면 셋이 같은 사실을 나눠 갖는다: [내 AI 계정](me-ai) · 처음 설정 «AI 잇기»(onboarding) · 알림이 여는 창(v2 main).
//  하나라도 어긋나면 조용히 죽는다 — 알림을 눌렀는데 «모르는 화면» 탭이 서거나, 로그인만 확인하고 판 자격은 안 받거나.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const MEAI = read("../web/me-ai.ts");
const ONB = read("../web/v2/onboarding.ts");
const MAIN = read("../web/v2/main.ts");
const CONNECT = read("../src/org/credentials/headless-connect.ts");
const code = (s) => s.split("\n").filter((l) => {
  const t = l.trim();
  return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
}).join("\n");

test("배선 · 소스를 실제로 읽었다(vacuous 방지)", () => {
  for (const s of [MEAI, ONB, MAIN, CONNECT]) assert.ok(s.length > 2000);
});

test("★ [내 AI 계정] — 상태를 서버 한 곳에서 읽고, [연결]은 헤드리스 용도로 **새로** 띄운다", () => {
  const c = code(MEAI);
  assert.match(c, /api\('\/api\/ui\/me\/headless'\)/, "행 상태의 출처는 /api/ui/me/headless 하나다");
  assert.match(c, /startInlineAiLogin\(h\.key, paint\(\), \{ restart, purpose: 'headless'/, "공용 프로토콜 · 헤드리스 용도");
  assert.match(c, /onclick: \(\) => run\(true\)/, "사람이 누른 연결은 새로 띄운다(지난 시도의 코드는 죽었다)");
  //  리뷰(#4051) — 다시 누르면 앞 시도의 폴링을 멈춘다(panel 이 같은 노드라 alive() 로는 안 멈춘다) · 연타는 흘린다.
  const run = c.slice(c.indexOf("const run = (restart?: boolean) => {", c.indexOf("function headlessRow")));
  assert.match(run.slice(0, 400), /handle\?\.stop\(\);[^]*handle = startInlineAiLogin\(/, "새로 띄우기 전에 앞 폴링을 멈춘다");
  assert.match(run.slice(0, 400), /if \(Date\.now\(\) - startedAt < 2500\) return;/, "연타를 흘린다");
  assert.match(c, /\.\.\.headlessSection\(headless, load\)/, "칸을 카드에 실제로 붙인다(안 붙이면 눌러도 아무 일이 없다)");
  //  #1675 의 «인증 실패» 줄은 행의 «멈춤» 으로 흡수했다 — 두 곳이 같은 실패를 따로 말하면 어긋난다.
  assert.ok(!/headlessAuthWarn\(/.test(c), "옛 실패 줄을 따로 그리지 않는다");
  assert.match(c, /text: '멈춤'/, "실패는 행의 상태로 말한다");
});

test("★ M11 실행 멤버 줄 — 연결됐는데 비어 있으면 그 자리에서 정한다(관리 화면으로 보내지 않는다)", () => {
  //  실측(2026-09-17): 데스크톱에서 연결한 관리자의 실행 멤버가 비었다. 관리 화면을 찾아가라고 하면 첫 사용자는 멈춘다.
  const c = code(MEAI);
  const i = c.indexOf("function runnerLine(st: any, reload: () => void)");
  assert.ok(i > 0, "실행 멤버 줄이 다시 그리기를 받는다");
  const body = c.slice(i, c.indexOf("function headlessSection", i));
  const cleared = body.indexOf("st.can_set_runner && r.source === 'db'");
  const claim = body.indexOf("st.can_set_runner && connected");
  assert.ok(cleared > 0 && claim > cleared, "관리자가 비운 자리 판정이 먼저다 — 버튼으로 그 결정을 뒤집지 않는다");
  assert.match(body.slice(claim), /api\('\/api\/ui\/me\/headless\/runner', \{ method: 'POST'/, "버튼은 정하기 경로를 부른다");
  assert.match(body.slice(claim), /reload\(\);/, "정한 뒤 다시 그린다");
  assert.match(body, /\.some\(\(h\) => h && h\.connected\)/, "연결 여부는 행에서 읽는다(연결 전엔 버튼 없이 종전 안내)");
  assert.match(body.slice(claim), /api\('\/api\/ui\/me\/headless\/runner', \{ method: 'POST', body: JSON\.stringify\(\{\}\) \}\)/,
    "몸통은 빈 객체 — 대상은 서버가 인증된 본인으로 정한다");
  assert.match(body.slice(claim), /runner === 'cleared'/, "비워 두기로 정해진 자리는 «이미 정해져 있다» 와 다르게 말한다");
  assert.match(c, /const line = runnerLine\(st, reload\);/, "칸이 다시 그리기를 넘긴다");
});

test("★ 처음 설정 — 로그인이 확인된 갈래에서만 묻고, 헤드리스 용도로 새로 띄운다", () => {
  const i = ONB.indexOf("if (aiOn(c.harness)) {");
  const j = ONB.indexOf("// ── CLI 가 이 자리에 없다", i);
  assert.ok(i > 0 && j > i, "연결됨 갈래를 찾았다");
  const connected = ONB.slice(i, j);
  assert.match(connected, /HEADLESS_INLINE\[c\.harness\] \? '<div class="ob-tok" id="hlBox" hidden><\/div>'/, "칸은 연결됨 갈래에만 있다");
  assert.equal((ONB.match(/id="hlBox"/g) || []).length, 1, "다른 갈래(로그인 전)에는 칸이 없다 — 로그인도 안 됐는데 묻지 않는다");
  const c = code(ONB);
  assert.match(c, /const hb = \$\('#hlBox', el\); if \(hb\) void paintHeadlessOffer\(hb, AIC\.harness/, "칸이 있을 때만 채운다");
  assert.match(c, /\{ restart: true, purpose: 'headless', alive: \(\) => document\.body\.contains\(box\) \}/);
  assert.match(c, /if \(!row\) return;/, "구 서버(상태 조회 없음)면 칸을 안 연다 — 누를 수 없는 버튼 금지");
});

test("★ 알림이 여는 창 — 서버가 적는 주소를 v2 가 창으로 받는다(탭을 만들지 않는다)", () => {
  const href = (CONNECT.match(/HEADLESS_NOTICE_HREF = "([^"]+)"/) || [])[1];
  assert.equal(href, "#/me/ai");
  const m = MAIN.match(/const ME_AI_ROUTE = (\/.*\/);/);
  assert.ok(m, "판정 정규식이 한 곳에 있다");
  const re = eval(m[1]);   // 소스의 정규식 그대로 — 서버 주소를 실제로 받는지 잰다
  assert.equal(re.test(href), true, "서버가 적는 주소를 받는다");
  assert.equal(re.test("#/me/ai?x=1"), true);
  assert.equal(re.test("#/me/aix"), false, "비슷한 다른 주소는 아니다");
  assert.equal(re.test("#/s/abc"), false);
  const c = code(MAIN);
  assert.equal((c.match(/ME_AI_ROUTE\.test\(/g) || []).length, 2, "hashchange 와 부팅 두 자리가 같은 판정을 쓴다");
  assert.equal((c.match(/openMeModal\(\{ tab: 'aiacct' \}\)/g) || []).length, 2, "두 자리 모두 [AI 계정 연결] 창을 연다");
  const k = c.indexOf("if (ME_AI_ROUTE.test(hash))");
  assert.ok(k > 0 && k < c.indexOf("const canon = canonSessionHash(hash)"), "탭을 고르기 전에 가로챈다");
  assert.match(c.slice(k, k + 400), /suppressHash\+\+;\s*location\.replace\(/, "주소를 되돌릴 때 라우터가 다시 그리지 않게 한다");
});
