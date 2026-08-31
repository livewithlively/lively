// 온보딩이 «읽는 중» 에서 멈추지 않는다 (#1631, 2026-08-31 실측)
//
//  신고: 파일 13개를 올렸는데 진행률이 **11 / 13 에서 멈춰 한참** 있었다.
//  원인은 두 축을 같은 것으로 본 것이다:
//    S.upN            = 파일이 **올라간** 수            (13)
//    w.uploads.total  = **자료로 등록된** 수(서버 축)   (11)
//  서버는 등록까지 됐을 때만 응답에 source_id 를 싣는데(terminal-files.ts) 클라이언트가 그 값을 버리고
//  올라간 수를 목표로 삼았다. 그래서 «오지 않는 2건» 을 기다렸고, 그 폴러엔 **상한이 없었다**.
//  (바로 옆 분석 단계엔 ANALYZE_TIMEOUT_MS 가 있다 — 여기만 없었다.)
//
//  web/ 은 브라우저 전용이라 실행할 수 없다. 이 저장소 선례(ai-login.test)대로 **그 코드의 모양**을 못 박는다.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SRC = readFileSync(
  new URL("../../../web/v2/onboarding.ts", import.meta.url).pathname.replace("/dist/", "/src/"), "utf8");
const READ = SRC.slice(SRC.indexOf("function startReading()"), SRC.indexOf("async function analyzeUploads"));

test("① 업로드 응답의 source_id 를 버리지 않는다 — 등록 여부는 거기서만 알 수 있다", () => {
  assert.match(SRC, /if \(up && up\.source_id\) \{ S\.upIn\+\+; \}/,
    "등록된 수를 안 센다 — 올라간 수만으로는 서버 축과 만나지 않는다");
  assert.match(SRC, /S\.upFail\.push\(/, "등록 안 된 파일을 기억하지 않는다 — 사람에게 말할 수 없다");
});

test("② 읽기 목표가 **등록된 수**다(올라간 수가 아니다)", () => {
  assert.match(READ, /const target = \(\) => Math\.max\(ingestedN\(\), S\.read\.total \|\| 0\)/,
    "목표가 등록 축이 아니다 — 등록이 하나라도 빠지면 영영 안 끝난다");
  assert.match(SRC, /function ingestedN\(\) \{ return S\.upIn == null \? \(S\.upN \|\| 0\) : S\.upIn; \}/,
    "축 helper 가 없거나 0 을 폴백한다 — upIn 이 «없는 것»과 «0인 것»은 다르다");
});

//  ★ 이 판(2026-08-31 2차)의 본체다. 1차 수정은 target() 만 고쳤는데, **업로드 루프가 매 파일마다
//   S.read.total = S.upN 을 박고 있어서** target 의 read.total 항으로 올라간 수가 되살아났다.
//   실측(자료 0건 워크스페이스, 8개 중 5개만 등록): 5/8 에서 60초 상한이 물 때까지 멈춰 있었다.
//   상한이 사람을 구했을 뿐 «멈춤» 자체는 그대로였다.
test("②' read.total 을 쓰는 모든 자리가 같은 축이다 — 한 곳만 올라간 수를 박아도 되살아난다", () => {
  const writes = [...SRC.matchAll(/S\.read\.total = ([^;]+);/g)].map((m) => m[1].trim());
  assert.ok(writes.length >= 2, `read.total 대입을 못 찾았다(${writes.length}) — 검사가 헛돈다`);
  for (const w of writes) {
    assert.doesNotMatch(w, /\bS\.upN\b/,
      `read.total 에 올라간 수를 박는다: «${w}» — 이 한 줄이 target() 의 read.total 항으로 되살아난다`);
  }
});

test("③ 폴러에 상한이 있다 — 없으면 무한히 돈다(이 신고의 본체)", () => {
  assert.match(READ, /READ_MAX_MS/, "상한 상수가 없다");
  assert.match(READ, /Date\.now\(\) - readStarted > READ_MAX_MS/, "상한을 실제로 검사하지 않는다");
  assert.match(READ, /finish\(\);/, "상한을 넘겨도 끝내지 않는다");
});

test("④ 상한을 넘기면 **사실대로 말한다** — 조용히 넘어가지 않는다", () => {
  assert.match(READ, /아직 정리에 안 들어왔어요/, "몇 건이 빠졌는지 말하지 않는다");
  assert.match(READ, /const left = Math\.max\(0, target\(\) - S\.read\.done\)/, "빠진 수를 세지 않는다");
});

//  ★ 상한에 안 걸리고 **정상 완료**하는 길이 훨씬 흔하다(등록 축을 고쳤으니 이제 그쪽이 기본이다).
//   그 길에서 아무 말도 안 하면, 8개를 올린 사람이 5건만 들어간 것을 모르고 넘어간다.
test("④' 정상 완료·0건 완료에서도 등록 못 한 파일을 말한다", () => {
  assert.match(SRC, /function noteFail\(\)/, "실패를 말하는 자리가 없다");
  const calls = (READ.match(/noteFail\(\)/g) || []).length;
  assert.ok(calls >= 3, `startReading 안에서 noteFail 이 ${calls}군데서만 불린다 — 정상완료·상한·0건 세 자리다`);
  assert.match(READ, /if \(S\.read\.done >= target\(\)\) \{ finish\(\); noteFail\(\); return; \}/,
    "정상 완료 때 말하지 않는다");
});

//  ★ 안내가 **보이는 자리**에 있어야 한다(2026-08-31).
//   1차: 안내를 띄웠는데 enterChat 이 대화창을 비워서 지워졌다 — 그래서 비운 쪽이 다시 말하게 했다.
//   2차: 리브 챗 문답을 통째로 걷어내자(#1631, 원준님) 대화창(#thread)이 **어느 장면에서도 안 보이게** 됐다.
//    거기 쓰면 죽지는 않지만 아무도 못 본다 — «말했다» 로 기록만 남는 가장 나쁜 모양이다.
//    그래서 S.notes 에 담고 **마무리 화면**이 말한다(사람이 실제로 읽는 마지막 자리).
test("④'' 안내가 사람이 보는 자리에 나온다 — 기록만 남기고 사라지지 않는다", () => {
  assert.match(SRC, /function noteFail\(\)/, "등록 실패를 남기는 자리가 없다");
  assert.match(SRC, /S\.notes\.push\(`파일 <b>\$\{fails\.length\}건<\/b>/, "안내를 S.notes 에 안 담는다");
  //  ⚠ 안 보이는 칸(#thread)에 쓰면 안 된다 — 챗이 없어져 그 칸은 어느 장면에서도 안 뜬다.
  assert.doesNotMatch(SRC, /msgLiv\(`파일 <b>/, "안 보이는 대화창에 쓴다 — 아무도 못 본다");
  //  그리고 마무리가 그것을 실제로 말해야 한다.
  const fin = SRC.slice(SRC.indexOf("async function finishOnboarding("));
  assert.match(fin.slice(0, 3000), /const notes = \(S\.notes \|\| \[\]\)\.filter\(Boolean\);/, "마무리가 안내를 읽지 않는다");
  assert.match(fin.slice(0, 3000), /notes\.length \? `<p[^`]*\$\{notes\.join/, "마무리가 안내를 화면에 안 쓴다");
});

//  사유는 **서버가 준 것만** 옮긴다. 지어내면 «압축이라 안 됩니다» 를 텍스트 파일에도 말하게 된다.
test("⑤' 등록 실패 사유를 서버에서 받아 옮긴다 — 화면이 추측하지 않는다", () => {
  const srv = readFileSync(
    new URL("../../terminal/terminal-files.ts", import.meta.url).pathname.replace("/dist/", "/src/"), "utf8");
  assert.match(srv, /skipped: ing\.reason/, "서버가 등록 실패 사유를 안 내려준다");
  assert.match(SRC, /why: \(up && up\.skipped\) \|\| null/, "화면이 그 사유를 안 받는다");
  assert.match(SRC, /function failWhy\(fails\)/, "사유를 사람 말로 옮기는 자리가 없다");
  assert.doesNotMatch(SRC, /failWhy[\s\S]{0,600}return ' — 압축[^']*';\s*\}/,
    "사유가 없을 때도 형식을 단정한다 — 서버가 말 안 한 것을 지어내면 안 된다");
});

test("⑤ 리브가 안 열렸으면 **왜** 안 열렸는지 말한다", () => {
  assert.match(SRC, /applied\.liv\.reason === 'ai-not-connected'/,
    "서버가 준 사유를 안 쓴다 — 시킨 걸 다 한 사람이 «리브는 어디 갔지» 로 남는다");
  assert.match(SRC, /\[외부 앱 연결\]에서 AI 를 이으면/, "사유만 말하고 갈 길을 안 준다");
});

test("⑥ 올린 게 0건이면 기다리지 않는다(무회귀)", () => {
  assert.match(READ, /if \(!target\(\)\) \{ finish\(\); noteFail\(\); return; \}/,
    "0건일 때 즉시 끝내는 길이 사라졌다");
});

//  ★ 축을 가른 뒤 남는 어긋남: 화면 문구가 «받은 수»로 «읽었다»를 말하는 것.
//   실측(2026-08-31): 방금 «3건은 못 넣었어요» 라고 해 놓고 바로 다음 장면이 «파일 8개를 받아서 읽는 중입니다»
//   라고 했다. 사람이 보기엔 제품이 앞뒤로 다른 말을 한다.
//   규칙: «받았다/올렸다»는 upN, «읽는다/읽었다/자료 N건»은 등록 축(ingestedN·realTotal).
test("⑦ «읽었다»를 올라간 수로 말하지 않는다 — 받은 수와 읽은 수는 다르다", () => {
  const lines = SRC.split("\n");
  const bad: string[] = [];
  lines.forEach((ln, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(ln)) return;              // 주석은 규칙을 설명하는 자리다
    if (!/S\.upN/.test(ln)) return;
    if (/읽는|읽었|자료 <b>|자료 \$\{/.test(ln)) bad.push(`${i + 1}: ${ln.trim().slice(0, 110)}`);
  });
  assert.deepEqual(bad, [], `«읽었다»를 S.upN 으로 말하는 줄이 있다:\n${bad.join("\n")}`);
});

//  realTotal 은 «자료 N건» 을 말하는 모든 자리(첫 대면 · 다 읽었어요 · 이어 열기)의 바닥이다.
//   여기 upN 이 들어가면 세 자리가 한꺼번에 틀린다.
test("⑧ realTotal 의 바닥이 등록 축이다", () => {
  assert.match(SRC, /const realTotal = \(\) => Math\.max\(ingestedN\(\),/,
    "realTotal 이 올라간 수를 바닥으로 쓴다 — 읽지 않은 것을 읽었다고 말하게 된다");
});
