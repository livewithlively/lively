// 처음 설정 맨 앞의 인사 장면 (#1631, 원준님 2026-09-13 → #4970 단일화, 상민님 2026-10-22)
//
//  지시(#1631): 이름을 묻는 화면에 들어가기 전에, 공들인 애니메이션과 함께 «… 이 뒤에서는, 라이블리 사용을 위한 기본 설정을 진행합니다. [계속하기]».
//  (#4970) 처음 설정은 인사 → 이름 → «외부 앱을 연결하시겠어요?» 하나로 줄었다 — 합류자 차례표(팀 소개)가 없어졌고, 인사 제목에서 «Beta» 를 뺐다.
//
//  왜 소스를 읽나 — 이 화면의 고장은 오류를 내지 않는다(인사가 안 뜨거나, 인사만 본 사람이 다음 로그인에 끌려온다). 이 레포의 테스트엔
//   DOM 이 없어서 판정 식(차례표·저장 문턱·셸 판정·[계속하기] 배선)을 **소스에서 꺼내 실제로 계산**한다. 글자 모양이 아니라 계산 결과로
//   단언하므로, 식을 고쳐 써도 뜻이 같으면 통과하고 뜻이 바뀌면 빨개진다. 타입 표기(`$<T>(…)!`·`!`)는 걷고 돌린다.
//
//  엣지 표 → 테스트:
//   E1 진행 없음                        → 인사 → [계속하기] → 이름
//   E2 차례표는 한 벌이고 인사에서 시작   → 합류자 차례표 없음 · 인사 다음 = 차례표 둘째
//   E3·E5 인사 · 빈 이름에만 머묾        → 진행으로 남기지 않는다
//   E6·E7 이름을 적음 · 이름 다음 장면   → 남긴다(옛 판 장면에 멈춘 탭 포함)
//   E8 탭 저장본이 인사·빈 이름뿐        → «이 탭에 진행 있음» 이 아니다(서버에 묻는다)
//   E9 새로 만든 목록(BEFORE_ANSWER)     → 마운트 중에 읽히므로 모든 쓰임보다 먼저 선언된다(TDZ)
//   E10 셸                               → 인사는 이름처럼 민낯, 연결 물음은 유령 셸
//   E11 인사의 출구                      → 하나 · 차례표를 따른다(가짜 차례표로 고정값 탐지)
//   E12 움직임 줄이기                    → 인사 애니메이션은 전부 no-preference 안 · 건너가는 점은 기본이 숨김
//   E13 문구                             → 정한 문구 그대로 · «Beta» 없음
//   E14 보조기기                         → 그림은 숨긴다
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (rel: string): string =>
  readFileSync(new URL(rel, import.meta.url).pathname.replace("/dist/", "/src/"), "utf8");
//  주석 줄은 뺀다 — 주석에 옛 식이 남아 있어도 그건 동작이 아니다.
const code = read("../../../web/v2/onboarding.ts").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
const CSS = read("../../../public/styles/41-onboarding.css");

type Fn = (...args: unknown[]) => unknown;
const compile = (params: string[], body: string): Fn => new Function(...params, body) as unknown as Fn;
/** TS 표기 걷기 — `$<HTMLButtonElement>(` → `$(`, 끝의 non-null 단언 `)!` · `]!` → `)` · `]`. */
const js = (src: string): string => src.replace(/\$<[A-Za-z]+>\(/g, "$(").replace(/\)!/g, ")").replace(/\]!/g, "]");

/** 소스에서 캡처 하나를 꺼낸다 — 못 찾으면 검사가 헛돌지 않게 그 자리에서 실패한다. */
const grab = (re: RegExp, what: string): string => {
  const m = code.match(re);
  assert.ok(m, `${what} 를 소스에서 못 찾았다 — 검사가 헛돈다`);
  return m![1]!;
};
const list = (name: string): string[] =>
  JSON.parse(grab(new RegExp(`const ${name} = (\\[[^\\]]*\\]);`), name).replace(/'/g, '"')) as string[];

/** 소스의 nextScene 식을 주어진 차례표로 돌린다. */
const nextSceneOn = (order: string[]) => {
  //  (#5060) 다음 장면은 «지금 보여 주는 장면만» 센다(appliesScene — 앱 장면은 앱 안·윈도우/맥이 아닌 곳에서 건너뛴다). 그 판정은
  //   onboarding-app-scene-runtime A3~A5 가 잰다 — 여기서는 전부 보여 주는 판으로 돌린다(차례 그 자체를 잰다).
  const fn = compile(["ORDER", "cur", "appliesScene"], js(grab(/const nextScene = \(cur: string\): string \| null => \{([^}]*)\};/, "nextScene")));
  return (cur: string) => fn(order, cur, () => true);
};

/** 단추 하나짜리 장면의 bind 를 가짜 DOM 으로 돌려 «누르면 어디로 가나» 를 잰다. */
function pressOnly(scene: string, order: string[]): string {
  const src = js(grab(new RegExp(`\\n    ${scene}: \\{[\\s\\S]*?\\n      bind: (\\(el\\) => \\{.*\\}),\\n`), `${scene} 장면의 bind`));
  const btn: { onclick?: () => void } = {};
  const hit = { to: "" };
  const bind = compile(["$", "goScene", "nextScene"], `return ${src};`)(
    () => btn, (k: string) => { hit.to = k; }, nextSceneOn(order)) as (el: unknown) => void;
  bind({});
  assert.equal(typeof btn.onclick, "function", `${scene} 장면에 누를 단추가 안 걸렸다`);
  btn.onclick!();
  assert.ok(hit.to, `${scene} 장면의 단추가 아무 데도 안 보낸다`);
  return hit.to;
}

type Saved = { scene: string; nameSet?: boolean };
const worthSaving = (S: Saved): boolean =>
  !!compile(["S", "BEFORE_ANSWER"], `return (${grab(/const worthSaving = \(\) => ([^;]+);/, "worthSaving")});`)(S, list("BEFORE_ANSWER"));
const hadLocal = (v: Saved): boolean =>
  !!compile(["v", "BEFORE_ANSWER"], `return (${grab(/\{ S = Object\.assign\(fresh\(\), pickState\(v\)\); hadLocal = ([^;]+); \}/, "hadLocal 판정")});`)(v, list("BEFORE_ANSWER"));

test("E1 진행이 없는 사람은 인사를 먼저 보고, [계속하기] 다음이 이름이다", () => {
  const order = list("ORDER");
  const freshScene = grab(/const fresh = \(\): ObState => \(\{ scene: '([a-z-]+)'/, "처음 상태(fresh)의 장면");
  assert.equal(freshScene, "intro", "처음 상태가 인사가 아니다");
  assert.equal(pressOnly("intro", order), "name", "인사 다음이 이름이 아니다");
});

test("E2 차례표는 한 벌이고 인사에서 시작한다 — 인사 다음은 차례표의 둘째 장면", () => {
  const names = [...code.matchAll(/const (ORDER\w*) = \[/g)].map((m) => m[1]);
  assert.deepEqual(names, ["ORDER"], `차례표가 한 벌이 아니다(합류자 갈래가 남았다): ${names.join(", ")}`);
  const f = list("ORDER");
  assert.equal(f[0], "intro", "차례표가 인사에서 시작하지 않는다");
  assert.equal(pressOnly("intro", f), f[1], "인사 다음이 차례표의 둘째 장면이 아니다");
});

test("E3·E5 아무것도 답하지 않은 자리(인사·빈 이름)에 머문 것은 진행으로 남기지 않는다", () => {
  for (const scene of ["intro", "name"]) {
    assert.equal(worthSaving({ scene, nameSet: false }), false, `${scene} 에만 머문 사람이 «하다 만 사람» 으로 저장돼 다음 로그인에 끌려온다`);
  }
});

test("E6·E7 답이 하나라도 있으면 남긴다 — 이름을 적었거나 이름 다음 장면에 닿았다(옛 판 장면 포함)", () => {
  assert.equal(worthSaving({ scene: "intro", nameSet: true }), true, "이름을 적고 인사로 되돌아간 사람의 답을 버린다");
  const later = list("ORDER").filter((k) => !["intro", "name"].includes(k));
  assert.ok(later.length >= 1, "이름 다음 장면을 못 찾았다 — 검사가 헛돈다");
  for (const scene of [...later, "stage", "claude", "app"]) {
    assert.equal(worthSaving({ scene, nameSet: false }), true, `${scene} 까지 온 사람의 진행을 안 남긴다`);
  }
});

test("E8 탭 저장본이 인사·빈 이름뿐이면 «이 탭에 진행 있음» 이 아니다 — 서버에 묻는다", () => {
  for (const scene of ["intro", "name"]) {
    assert.equal(hadLocal({ scene, nameSet: false }), false, `${scene} 저장본이 서버의 진행을 가린다`);
    assert.equal(hadLocal({ scene }), false, `${scene} 저장본(nameSet 없음)이 서버의 진행을 가린다`);
  }
  assert.equal(hadLocal({ scene: "intro", nameSet: true }), true, "이름을 적은 탭의 진행을 버리고 서버 것으로 덮는다");
  assert.equal(hadLocal({ scene: "connect-ask" }), true, "이름 다음까지 온 탭의 진행을 무시한다");
});

test("E8′ 아무것도 답하지 않은 탭이 「이름」에 멈춰 있어도 서버에 진행이 없으면 인사부터 연다", () => {
  //  배포 직후 가장 흔한 길 — 옛 처음 설정을 한 번 본 탭은 저장본이 {scene:'name'} 이다. 그 탭에서 다시 열면
  //   hadLocal=false 라 서버에 묻고, 진행이 없으면 «처음부터» 로 가는데 그때 S.scene 을 그대로 쓰면 인사를 건너뛴다.
  const tail = js(grab(/toast\('지난번에 하시던 자리에서 이어 갑니다\.'\);\s*return;\s*\}\s*([\s\S]*?)\n  \}\n/, "이어 열기의 «처음부터» 갈래"));
  const BEFORE = list("BEFORE_ANSWER");
  const ORDER = list("ORDER");
  const fitScene = (k: unknown): string | null => { const x = String(k || ""); return ORDER.includes(x) ? x : x === "team" ? "name" : x ? "connect-ask" : null; };
  for (const start of ["name", "intro"]) {
    const S: { scene: string; nameSet: boolean; trail: string[] } = { scene: start, nameSet: false, trail: start === "intro" ? [] : ["intro"] };
    const hit = { to: "" };
    //  (#5060) landOn — 보여 주지 않는 장면이면 그다음으로(앱 안에서 «앱 받기» 를 다시 안 보이게). 이 행의 관심사가 아니라 그대로 통과시킨다.
    compile(["S", "ORDER", "BEFORE_ANSWER", "fitScene", "goScene", "landOn"], tail)(S, ORDER, BEFORE, fitScene, (k: string) => { hit.to = k; }, (k: string | null) => k);
    assert.equal(hit.to, "intro", `저장본 ${start} 에서 인사를 건너뛰고 ${hit.to} 부터 연다`);
    assert.deepEqual(S.trail, [], `저장본 ${start} 의 옛 자취가 남아 첫 장면의 «뒤로» 가 옛 자리로 간다`);
  }
});

test("E9 새로 만든 목록은 마운트 중에 읽힌다 — 모든 쓰임보다 먼저 선언돼 있다(TDZ)", () => {
  const decl = code.indexOf("const BEFORE_ANSWER");
  assert.ok(decl >= 0, "BEFORE_ANSWER 선언이 없다");
  const at = [...code.matchAll(/BEFORE_ANSWER/g)].map((m) => m.index ?? -1);
  assert.ok(at.length >= 3, "선언 + 쓰임 둘(hadLocal·worthSaving)이 아니다");
  assert.equal(Math.min(...at), decl + "const ".length, "선언보다 앞선 쓰임이 있다 — 마운트 중 TDZ 로 화면이 통째로 죽는다");
});

test("E10 인사는 이름처럼 민낯이다 — 연결 물음은 유령 셸", () => {
  const stageOf = compile(["key"], `return (${grab(/setStage\((key === [^)]*? \? 'stage-name' : 'stage-q')\);/, "장면별 셸 판정")});`);
  assert.equal(stageOf("intro"), "stage-name", "인사 뒤로 흐린 사이드바가 비친다");
  assert.equal(stageOf("name"), "stage-name", "이름 화면이 민낯이 아니게 됐다(무회귀)");
  assert.equal(stageOf("connect-ask"), "stage-q", "연결 물음의 셸이 민낯이 됐다");
});

test("E11 인사의 출구는 하나고, 다음 장면은 차례표가 정한다", () => {
  const intro = code.slice(code.indexOf("    intro: {"), code.indexOf("    name: {"));
  assert.ok(intro.length > 0 && code.indexOf("    intro: {") >= 0, "인사 장면을 못 찾았다 — 검사가 헛돈다");
  assert.equal((intro.match(/goScene\(/g) || []).length, 1, "인사에서 나가는 길이 하나가 아니다");
  //  고정값인지는 글자가 아니라 행위로 잰다 — 가짜 차례표에서도 인사 다음이 그 차례표를 따르나.
  assert.equal(pressOnly("intro", ["intro", "zzz", "name"]), "zzz", "인사 다음을 차례표 대신 고정값으로 보낸다");
});

test("E12 움직임 줄이기 설정이면 인사는 움직이지 않는다 — 애니메이션은 no-preference 안에만, 건너가는 점은 기본이 숨김", () => {
  let rest = CSS.replace(/\/\*[\s\S]*?\*\//g, "");
  const OPEN = "@media (prefers-reduced-motion: no-preference)";
  const inside: string[] = [];
  for (let i = rest.indexOf(OPEN); i >= 0; i = rest.indexOf(OPEN)) {
    const j = rest.indexOf("{", i);
    let depth = 0;
    let k = j;
    for (; k < rest.length; k++) {
      if (rest[k] === "{") depth++;
      else if (rest[k] === "}" && --depth === 0) break;
    }
    inside.push(rest.slice(j + 1, k));
    rest = rest.slice(0, i) + rest.slice(k + 1);
  }
  assert.match(inside.join("\n"), /\.ob-in-[a-z-]+[^{]*\{[^}]*animation\s*:/, "인사 그림에 움직임이 없다 — 검사가 헛돈다");
  const rules = [...rest.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, sel, body]) => ({ sel: sel!.trim(), body: body! }));
  const leaked = rules.filter((r) => /\.ob-in-/.test(r.sel) && /animation(-name)?\s*:/.test(r.body)).map((r) => r.sel);
  assert.deepEqual(leaked, [], "움직임 줄이기 설정에서도 도는 인사 애니메이션이 있다");
  //  «끝난 그림» 에 건너가는 점이 남으면 안 된다 — 움직임이 없을 때 그 점은 선 한가운데 멈춘 얼룩이 된다.
  const run = rules.find((r) => r.sel === ".ob-in-run");
  assert.ok(run, ".ob-in-run 기본 규칙을 못 찾았다 — 검사가 헛돈다");
  assert.match(run!.body, /opacity\s*:\s*0\b/, "건너가는 점이 기본으로 보인다 — 움직임 없는 화면에 점이 박혀 있다");
});

test("E13 문구는 정한 그대로다 — 인사 제목에 «Beta» 가 없다(#4970)", () => {
  const COPY = grab(/export const OB_COPY = \{([\s\S]*?)\n\};/, "OB_COPY");
  for (const s of [
    "introTitle: '라이블리에 오신 것을 환영합니다'",
    "introBody: 'Lively는 사용자가 놓여있는 맥락을 저희가 직접 AI에게 풍부하게 주입해서 AI의 세팅 난이도를 줄이고, 양질의 결과물을 얻을 수 있도록 합니다.'",
    "introNext: '이를 위해서 이 뒤에서는, 라이블리 사용을 위한 기본 설정을 진행합니다.'",
  ]) assert.ok(COPY.includes(s), `문구가 다르다: ${s}`);
  assert.doesNotMatch(code, /Beta/, "«Lively Beta» 문구가 남아 있다");
  const intro = code.slice(code.indexOf("    intro: {"), code.indexOf("    name: {"));
  for (const k of ["OB_COPY.introTitle", "OB_COPY.introBody", "OB_COPY.introNext", ">계속하기</button>"]) {
    assert.ok(intro.includes(k), `인사 장면이 ${k} 를 안 쓴다`);
  }
});

test("E14 그림은 보조기기에 숨긴다 — 같은 말을 문장이 한다", () => {
  assert.match(code, /<div class="ob-in-art" aria-hidden="true">/, "흐름도 조각(문서·대화·업무·Lively·AI)을 화면 읽기 프로그램이 낱말로 읽는다");
});
