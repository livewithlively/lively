// AI 연결 화면의 아래 버튼은 **하나**다 (#1631, 원준님 2026-08-31)
//
//  신고: *"지금 클로드, 지피티, 제미나이 등 연결하는 과정에서 맨 밑에 버튼이 [로그인했어요][이대로 계속]
//   [다른 AI 고르기] 이렇겐데, 그냥 버튼이 너무 많은 것 같아. 로그인 했어요 누르면 확인되면 그 다음에
//   바로 그냥 이번꺼 연결된 표시 띄워서 이전 하네스 목록 있는 화면으로 보내고 거기서 더 연결할건지
//   체크하게 하면 되는거 아닌가?"*
//
//  ★ 그 흐름은 **이미 있었다** — cGo 성공 → pass() → renderScene('claude') → «연결됐어요 + AI 4장» 화면.
//   문제는 성공 경로가 아니라 그 아래에 선 곁다리 버튼 둘이었다. 그래서 그것만 걷어낸다.
//     · [다른 AI 고르기] = 머리말 [← 이전]과 같은 곳 → 중복
//     · [이대로 계속]/[나중에 할게요] = 같은 곳(sources)으로 가는 한 문인데 이름만 둘
//
//  ⚠ 이 검사는 «버튼을 지웠나» 가 아니라 «주 버튼 하나 + 빠져나갈 문 하나» 를 지킨다.
//   문까지 지우면 로그인이 안 되는 사람이 갇힌다 — 그건 이 장면 머리말이 세운 원칙을 깨는 것이다.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SRC = readFileSync(
  new URL("../../../web/v2/onboarding.ts", import.meta.url).pathname.replace("/dist/", "/src/"), "utf8");
//  claude 장면의 html() 만 — bind 는 따로 본다.
const RAW = SRC.slice(SRC.indexOf("    claude: {"), SRC.indexOf("      bind: (el) => {", SRC.indexOf("    claude: {")));
//  ⚠ **주석을 걷어내고 잰다.** 이 수정의 근거를 적은 주석에 «다른 AI 고르기» 가 그대로 들어 있어서,
//   안 걷어내면 «지웠는데 가드가 운다» 가 된다(첫 판이 실제로 그렇게 걸렸다). 규칙을 설명한 문장이
//   그 규칙의 위반으로 잡히면, 다음 사람은 가드를 고치는 대신 **설명을 지운다**.
const strip = (t: string): string => t.split("\n").filter((ln) => !/^\s*(\/\/|\*|\/\*)/.test(ln)).join("\n");
const SCENE = strip(RAW);
//  ⚠ 원준님이 지적한 것은 **«로그인해 주세요» 화면**이다(로그인했어요/이대로 계속/다른 AI 고르기).
//   «그 AI 가 이 자리에 아예 없다» 갈래는 **다른 화면**이고, 거기선 [다른 AI 고르기]가 머리말 뒤로가기의
//   중복이 아니라 실질적인 다음 행동이다(#1879 — 고르게 해 놓고 이을 수 없는 자리를 막은 그 조치).
//   그래서 버튼 수 검사는 **로그인 갈래로 좁혀서** 한다. 안 좁히면 옳은 화면까지 함께 깎인다.
const LOGIN = strip(RAW.slice(RAW.indexOf("// ── 있는데 아직 로그인 전")));

test("① 로그인 화면에서 곁다리 버튼 둘이 사라졌다", () => {
  assert.ok(LOGIN.length > 200, "로그인 갈래를 못 잘랐다 — 검사가 헛돈다");
  assert.doesNotMatch(LOGIN, /다른 AI 고르기/,
    "[다른 AI 고르기]가 로그인 화면에 남아 있다 — 머리말 [← 이전]과 같은 곳이라 중복이다");
  assert.doesNotMatch(SCENE, /id="cKeep"/, "[이대로 계속] 버튼이 남아 있다 — 빠져나갈 문은 하나여야 한다");
});

test("② 그래도 빠져나갈 문은 **하나** 남아 있다 — 사람을 가두지 않는다", () => {
  assert.match(SCENE, /const laterLink = /, "문이 아예 없다 — 로그인 못 하는 사람이 갇힌다");
  assert.match(SCENE, /class="ob-q-skip" data-skip/, "문이 여전히 버튼 무게다 — 조용한 링크여야 한다");
  //  ob-btn 짜리 곁다리가 다시 늘지 않는지: 주 버튼(ob-btn-pri) 말고 ob-btn-sub 는 이 장면에 없어야 한다.
  //  (인라인 로그인 버튼 ob-btn-inline 은 본문 안이라 예외 — 아래 카운트에서 제외한다.)
  const subs = (LOGIN.match(/class="ob-btn ob-btn-sub"(?! ob-btn-inline)/g) || []);
  assert.deepEqual(subs, [], `로그인 화면 아래에 곁다리 버튼이 다시 늘었다(${subs.length}개)`);
});

test("③ 성공하면 목록 화면으로 간다 — 이 흐름을 지운 적 없다(무회귀)", () => {
  const BIND = SRC.slice(SRC.indexOf("      bind: (el) => {", SRC.indexOf("    claude: {")));
  assert.match(BIND, /const pass = \(name, key\) => \{ mark\(name, key\); toast\('연결됐어요\.'\); renderScene\('claude', false\); \};/,
    "성공 뒤 이 장면을 다시 그리지 않는다 — «연결됨 체크» 목록 화면에 못 닿는다");
  assert.match(SCENE, /연결됨<\/span><\/span><span class="ob-oc-chk">/,
    "연결된 AI 를 체크로 보여 주는 카드가 사라졌다");
  assert.match(SCENE, /data-more=/, "목록에서 다른 AI 를 눌러 추가 연결하는 길이 사라졌다");
});

test("④ 합쳐진 문이 «이미 이어진 AI» 를 잃지 않는다(옛 [이대로 계속]의 뜻)", () => {
  const BIND = SRC.slice(SRC.indexOf("      bind: (el) => {", SRC.indexOf("    claude: {")));
  const h = BIND.slice(BIND.indexOf("const skip = $('[data-skip]', el);"));
  assert.match(h.slice(0, 400), /if \(!S\.aiConnected && o\) mark\(AI_LABEL\[o\] \|\| o, o\);/,
    "이미 이어진 AI 를 표시하지 않고 넘어간다 — 연결해 둔 것이 없던 일이 된다");
});

//  ★ 이 검사는 **내가 방금 낸 버그** 때문에 있다(2026-08-31).
//   버튼을 줄이며 `const skip`·`keepBtn`·`goOther` 선언을 지웠는데, 갈래 **하나**(«확인하고 있어요…»)가
//   아직 `+ skip` 을 참조하고 있었다. 그 갈래는 AIC 가 아직 없을 때만 그려지는 자리라 다른 갈래를 아무리
//   봐도 안 보였고, 브라우저에서 AI 를 고르는 순간 `ReferenceError: skip is not defined` 로 **화면이 통째로
//   안 넘어갔다**. 문구를 못 박는 검사로는 절대 안 잡힌다 — 참조와 선언을 맞춰 봐야 잡힌다.
test("⑤ html() 안에 선언 없는 참조가 없다 — 갈래 하나만 남아도 그 화면이 통째로 죽는다", () => {
  const decl = new Set([...RAW.matchAll(/const (\w+) =/g)].map((m) => m[1]));
  const used = new Set([...RAW.matchAll(/\+ (\w+)[;\n]/g)].map((m) => m[1]));
  const dangling = [...used].filter((u) => !decl.has(u));
  assert.deepEqual(dangling, [],
    `html() 이 선언 없는 것을 이어 붙인다: ${dangling.join(", ")} — 그 갈래가 그려지는 순간 ReferenceError 로 화면이 멈춘다`);
});

