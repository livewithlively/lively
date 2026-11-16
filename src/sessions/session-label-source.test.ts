// 세션 이름 걸쇠 (#1979) — 이 표가 틀렸을 때 실제로 났던 일:
//  🔴 이름 쓰는 자리가 넷인데(생성 규칙 이름 · 헤드리스 AI 이름 · 전사 autoname · 사람 편집) "한 번만 짓는다"가
//     문자열 비교로만 흉내내져 있었다(`label === id` · `now !== ruleName`). 자리가 하나 늘 때마다 다시 깨졌고,
//     규칙 이름과 AI 이름이 우연히 같으면 판정이 뒤집혔다.
//  실행: npm run build && node dist/sessions/session-label-source.test.js
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { canRelabel, normalizeLabelSource, carriedLabelSource, carriedSourceOf, openingLabelSource, agentNamingOpen, SESSION_LABEL_SOURCE_ENV, type LabelSource } from "./session-label-source.js";

let pass = 0;
const ok = (name: string): void => { pass++; console.log(`ok  ${name}`); };

// ── 표 A — canRelabel(cur, next). 사양의 15행을 그대로 옮긴다(행 하나가 곧 못 잡는 버그다). ──
const TABLE: Array<[cur: LabelSource | null, next: LabelSource, want: boolean, why: string]> = [
  ["agent", "agent", false, "★핵심 — 한 번 지어지면 다시 안 지어진다"],
  ["human", "agent", false, "사람 이름을 에이전트가 못 덮는다"],
  ["human", "rule",  false, "뒤늦은 autoname 이 사람 이름을 못 지운다"],
  ["human", "id",    false, "id 폴백이 사람 이름을 못 지운다"],
  ["human", "human", true,  "★사람의 재개명은 늘 된다(막으면 그게 사고)"],
  ["agent", "human", true,  "사람이 에이전트 이름을 고친다"],
  ["rule",  "human", true,  "사람이 규칙 이름을 고친다"],
  ["id",    "human", true,  "사람이 이름 없는 세션에 이름을 준다"],
  ["rule",  "agent", true,  "주 경로 — 규칙 이름을 세션이 다듬는다"],
  ["id",    "agent", true,  "이름 없던 세션을 세션이 짓는다"],
  ["agent", "rule",  false, "★회귀 — 뒤늦은 autoname 이 agent 이름을 못 덮는다"],
  ["rule",  "rule",  false, "같은 순위 재작성 금지"],
  ["id",    "rule",  true,  "autoname 주 경로"],
  ["id",    "id",    false, "같은 순위 재작성 금지"],
  [null,    "agent", true,  "★label_source 이전 행(NULL)도 한 번은 다듬을 수 있어야 마이그레이션이 산다"],
];
for (const [cur, next, want, why] of TABLE) {
  assert.equal(canRelabel(cur, next), want, `canRelabel(${cur}, ${next}) = ${!want} — ${why}`);
}
ok(`걸쇠 표 ${TABLE.length}행 — agent 는 agent 를 못 덮고, human 은 늘 이기고, rule 은 agent 를 못 지운다`);

// 표가 vacuous 하지 않은지(관측 장치 확인) — 참·거짓이 둘 다 실제로 나와야 표가 무언가를 가르고 있다.
{
  const trues = TABLE.filter(([c, n]) => canRelabel(c, n)).length;
  assert.ok(trues > 0 && trues < TABLE.length, `표가 한쪽으로만 나온다(true ${trues}/${TABLE.length}) — 아무것도 안 가르고 있다`);
  ok("배선 확인 — 표가 허용/거부를 실제로 둘 다 만든다");
}

// ── 표 B — normalizeLabelSource. 저장 값이 흔들려도 판정이 흔들리면 안 된다. ──
for (const v of [null, undefined, "", "   ", "아무거나", "AGENT_X"]) {
  assert.equal(normalizeLabelSource(v), "rule", `${JSON.stringify(v)} 는 rule 로 봐야 한다`);
}
assert.equal(normalizeLabelSource(" HUMAN "), "human");
assert.equal(normalizeLabelSource("Agent"), "agent");
assert.equal(normalizeLabelSource("id"), "id");
ok("미상·NULL 은 rule 로, 값은 트림·소문자로 정규화된다");

// ★ 마이그레이션 안전 — 구 행(NULL)이 human 으로 읽히면 **기존 세션 전부가 영구히 못 다듬는 이름**이 된다.
assert.notEqual(normalizeLabelSource(null), "human");
ok("구 행(NULL)이 human 으로 읽히지 않는다 — 기존 세션이 영구 잠기지 않는다");

// ── 표 C — 세션을 여는 자리의 출처(#4418). 받아 온 이름은 사람 것 · 있던 세션을 잇는 길은 원래 출처 그대로. ──
const OPEN: Array<[given: string, label: string, carried: unknown, want: LabelSource, why: string]> = [
  ["태스크 이름", "태스크 이름", undefined, "human", "새로 여는 세션에 받아 온 이름 = 사람 것(태스크에서 열기 · 앱 만들기)"],
  ["", "첫 지시로 지은 이름", undefined, "rule", "이름을 안 받았으면 첫 지시 규칙 이름"],
  ["", "box-a-1", undefined, "id", "첫 지시도 없으면 id"],
  ["첫 지시로 지은 이름", "첫 지시로 지은 이름", "rule", "rule", "★복원 — 규칙 이름이 사람 이름으로 굳지 않는다"],
  ["AI 이름", "AI 이름", "agent", "agent", "복원 — AI 이름은 agent 그대로"],
  ["사람 이름", "사람 이름", "human", "human", "복원 — 사람 이름은 human 그대로"],
  ["box-a-1", "box-a-1", "id", "id", "복원 — 이름 없던 세션은 id 그대로(종전엔 id 가 사람 이름으로 굳었다)"],
  ["옛 이름", "옛 이름", null, "human", "실어 온 출처가 null 이면 실어 오지 않은 것"],
  ["옛 이름", "옛 이름", "", "human", "★경계 — 빈 문자열 출처도 실어 오지 않은 것"],
  ["옛 이름", "옛 이름", "???", "rule", "모르는 값은 rule(normalizeLabelSource)"],
  ["", "첫 지시로 지은 이름", "human", "rule", "★경계 — 이름을 안 받았으면 실어 온 출처는 쓰지 않는다"],
  ["  ", "box-a-1", "agent", "id", "공백뿐인 이름은 안 받은 것"],
];
for (const [given, label, carried, want, why] of OPEN) {
  assert.equal(openingLabelSource(given, label, "box-a-1", carried), want, `openingLabelSource(${JSON.stringify(given)}, …, ${JSON.stringify(carried)}) — ${why}`);
}
assert.equal(carriedLabelSource("", "agent"), null, "이름을 안 받았으면 null(여는 쪽이 rule/id 로 정한다)");
assert.equal(carriedLabelSource("x"), "human");
ok(`여는 자리의 출처 표 ${OPEN.length}행 — 받아 온 이름은 human · 실어 온 출처는 그대로 · 빈 이름엔 출처를 붙이지 않는다`);

// ── 표 D — 복원·전환이 실어 갈 출처(carriedSourceOf). 비어 있으면 안 싣는다 — 누가 지었는지 모르는 이름을 AI 가 바꾸지 않게. ──
for (const [stored, want] of [["agent", "agent"], ["human", "human"], ["rule", "rule"], ["id", "id"], [" Agent ", "agent"],
  [null, undefined], [undefined, undefined], ["", undefined], ["  ", undefined], ["???", "rule"]] as Array<[unknown, LabelSource | undefined]>) {
  assert.equal(carriedSourceOf(stored), want, `carriedSourceOf(${JSON.stringify(stored)})`);
}
//  ★ 이어서 — 출처 없는 옛 행을 되살리면 종전처럼 받아 온 이름(사람 것)으로 열린다(되살린 이름이 갑자기 바뀌지 않는다).
assert.equal(openingLabelSource("태스크 이름", "태스크 이름", "box-a-1", carriedSourceOf(null)), "human");
assert.equal(openingLabelSource("첫 지시 이름", "첫 지시 이름", "box-a-1", carriedSourceOf("rule")), "rule");
ok("복원이 실어 갈 출처 — 있으면 정규화해 잇고 · 비어 있으면 안 실어 종전처럼 human 으로 연다");

// ── 표 E — 안내 훅에 주는 답(agentNamingOpen, #5552). «지금 이 세션에 에이전트의 이름짓기가 먹히나». ──
//  🔴 틀리면: (true 쪽으로) 이미 이름이 정해진 세션에 세션 이름짓기가 안내돼 헛 툴콜과 «applied:false» 보고가 사람에게 보이고,
//            (false 쪽으로) 아직 이름 없는 세션이 안내를 못 받아 첫 지시를 자른 이름으로 남는다.
{
  const NAMING: Array<[row: { label_source?: unknown } | null | undefined, external: boolean, want: boolean | null, why: string]> = [
    [{ label_source: "agent" }, false, false, "★AI 가 이미 지었다 — 다시 안내하면 applied:false 만 본다"],
    [{ label_source: "human" }, false, false, "★사람이 지었다(태스크에서 연 세션 · 웹에서 고친 이름)"],
    [{ label_source: "rule" },  false, true,  "첫 지시를 자른 규칙 이름 — 한 번 다듬을 수 있다"],
    [{ label_source: "id" },    false, true,  "이름 없이 연 세션"],
    [{ label_source: null },    false, true,  "출처 칸 이전의 행·노드 발견 행 — 걸쇠가 rule 로 읽는다"],
    [{},                        false, true,  "출처가 없는 행"],
    [{ label_source: " Agent " }, false, false, "대소문자·공백은 걸쇠와 같게 정규화한다"],
    [{ label_source: "agent" }, true,  false, "외부 실행 id 라도 행이 있으면 행을 따른다"],
    [{ label_source: "id" },    true,  true,  "외부 실행 id 라도 행이 있으면 행을 따른다(열림)"],
    [undefined,                 true,  false, "★행이 없는 외부 실행 세션 — 이름을 담을 자리가 없어 session_rename 이 늘 applied:false 다"],
    [null,                      true,  false, "같다(null)"],
    [undefined,                 false, null,  "★라이블리가 띄운 세션인데 행이 아직 없다 — 모른다(닫힘으로 단정하면 그 세션은 영영 이름을 못 얻는다)"],
    [null,                      false, null,  "같다(null)"],
  ];
  for (const [row, external, want, why] of NAMING) {
    assert.equal(agentNamingOpen(row, external), want, `agentNamingOpen(${JSON.stringify(row)}, external=${external}) — ${why}`);
  }
  // 안내와 집행이 갈리지 않는다 — 행이 있으면 답은 걸쇠 표(canRelabel(·, agent))와 **같은 값**이어야 한다.
  for (const cur of ["id", "rule", "agent", "human", null, "???"] as const) {
    assert.equal(agentNamingOpen({ label_source: cur }, false), canRelabel(cur, "agent"), `행 출처 ${cur} — 안내 판정이 걸쇠와 다르다`);
  }
  const seen = new Set(NAMING.map(([r, e]) => String(agentNamingOpen(r, e))));
  assert.deepEqual([...seen].sort(), ["false", "null", "true"], "표가 세 값을 다 만들지 않는다 — 무언가를 안 가르고 있다");
  ok(`안내 훅에 주는 답 ${NAMING.length}행 — agent·human 은 닫힘 · id·rule·출처 없음은 열림 · 행 없는 외부 세션은 닫힘 · 행 없는 라이블리 세션은 모름`);
}

// ── 배선 — 여는 자리가 이 판정과 env 를 쓰고, 복원 두 갈래가 원래 출처를 싣는다(소스 대조). ──
{
  const src = (rel: string): string => readFileSync(new URL(`../../src/${rel}`, import.meta.url), "utf8");
  assert.equal(SESSION_LABEL_SOURCE_ENV, "LIVELY_SESSION_LABEL_SOURCE", "훅(session-name-ask)이 읽는 이름과 같아야 한다");
  const sessions = src("terminal/sessions.ts");
  assert.match(sessions, /const labelSource: LabelSource = openingLabelSource\(cleanLabel\(input\.label\), label, id, input\.labelSource\);/,
    "createSession 이 여는 자리의 출처 판정을 안 쓴다");
  assert.match(sessions, /args\.push\("-e", `\$\{SESSION_LABEL_SOURCE_ENV\}=\$\{labelSource\}`\);/, "pane env 로 출처를 안 싣는다(훅이 못 본다)");
  const routes = src("terminal/routes.ts");
  const carried = routes.match(/labelSource: carriedSourceOf\(st\.label_source\)/g) || [];
  assert.equal(carried.length, 2, `복원 두 갈래(노드 · 중앙)가 원래 출처를 실어야 한다(지금 ${carried.length})`);
  const hook = readFileSync(new URL("../../kit/hooks/examples/session-name-ask.org-hook.mjs", import.meta.url), "utf8");
  assert.match(hook, /LIVELY_SESSION_LABEL_SOURCE/, "훅이 같은 env 이름을 읽어야 한다");
  //  #5552 — 서버의 지금 값이 훅까지 닿는 길 전체. 한 군데라도 끊기면 안내 훅은 **조용히** pane env 로 물러나, 고친 것이 통째로
  //   안 돈다(실패가 안 보인다). 그래서 이음매마다 못박는다.
  //  ① 서버 — 프로젝트 맥락 응답이 걸쇠와 같은 판정(agentNamingOpen)으로 naming_open 을 싣는다. 모르면(null) 싣지 않는다.
  const ctxRoutes = src("terminal/session-project-routes.ts");
  assert.match(ctxRoutes, /const namingOpen = rowRead \? agentNamingOpen\(row, isExternalExecutionSessionId\(id\)\) : null;/,
    "프로젝트 맥락 응답이 걸쇠와 같은 판정(agentNamingOpen)을 안 쓴다 — 또는 행 조회 실패를 «행 없음» 으로 읽는다");
  assert.match(ctxRoutes, /if \(namingOpen !== null\) base\.naming_open = namingOpen;/, "모르는 경우(null)까지 응답에 실으면 훅이 그걸 «닫힘» 으로 읽는다");
  //   · changed 와 무관하게 매번 — naming_open 을 싣는 줄이 «안 바뀌었으면 여기서 끝» 보다 앞이어야 한다.
  assert.ok(ctxRoutes.indexOf("base.naming_open = namingOpen") < ctxRoutes.indexOf("if (!base.changed) return base;"),
    "naming_open 을 AGENTS.md 가 바뀐 턴에만 싣는다 — 이름은 그와 무관하게 바뀐다(첫 턴 뒤 AI 가 이름을 지은 세션)");
  //  ② 맥락 훅이 받아 적고 ③ 안내 훅이 읽는다 — 같은 파일 이름 · 같은 두 값.
  const ctxHook = readFileSync(new URL("../../kit/hooks/examples/project-agents-inject.org-hook.mjs", import.meta.url), "utf8");
  assert.match(ctxHook, /path\.join\(FLAG_DIR, `\$\{executionId\}\.naming`\)/, "맥락 훅이 naming_open 을 로컬에 안 적는다");
  assert.match(ctxHook, /body\.naming_open \? "open" : "closed"/, "맥락 훅이 적는 값이 open·closed 가 아니다");
  assert.match(hook, /path\.join\(FLAG_DIR, `\$\{boxId\}\.naming`\)/, "안내 훅이 맥락 훅이 적은 파일을 안 읽는다");
  assert.match(hook, /v === "open" \? true : v === "closed" \? false : null/, "안내 훅이 읽는 값이 open·closed 가 아니다");
  //  ④ 순서 — 러너는 묶음을 sort 오름차순으로 **차례로** 돌린다. 맥락 훅이 안내 훅보다 앞 묶음이어야 같은 턴의 값을 읽는다
  //   (같은 묶음이면 둘이 나란히 돌아 안내 훅이 앞 턴의 값이나 빈 자리를 본다).
  {
    const dc = src("org/delivery/default-content.ts");
    const sortOf = (id: string): number => {
      const m = new RegExp(`"id": "${id}",[\\s\\S]*?"sort": (\\d+),`).exec(dc);
      assert.ok(m, `시드 훅 ${id} 를 못 찾았다`);
      return Number(m[1]);
    };
    assert.ok(sortOf("project-agents-inject") < sortOf("session-name-ask"),
      `맥락 훅(sort ${sortOf("project-agents-inject")})이 안내 훅(sort ${sortOf("session-name-ask")})보다 앞 묶음이 아니다`);
  }
  ok("배선 — createSession 판정·env · 복원 두 갈래 출처 싣기 · 훅이 같은 env 를 읽는다 · 서버 값(naming_open)이 맥락 훅을 거쳐 안내 훅까지 닿는다");
}

console.log(`\n${pass} passed`);
