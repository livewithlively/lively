// 증류기 ⑤ 지시문 조각 편집란 — "미리보기 갱신이 편집란을 갈아치우지 않는다" 불변식 가드 (#1557)
//
// 무엇을 지키나: 이 화면의 미리보기는 입력이 바뀔 때마다(디바운스 0.6초) 서버에 물어 반사판을 갱신하고,
//  그 응답에는 지시문 조각(sections)도 함께 온다. 응답을 받을 때마다 조각 편집란(textarea)을 **새로 그리면**
//  사람이 지금 타이핑하던 요소가 DOM 에서 사라진다.
//
// 이 불변식이 깨지면 실제로 나는 일 (실측 #1557 — 사용자 신고 "프롬프트 커스텀 못해?"):
//  🔴 한 글자 치고 0.6초가 지나면 그 textarea 가 교체되어 **포커스가 BODY 로 빠진다.** 값 자체는 서버가
//     override 로 돌려줘 복원되지만, 커서가 매번 사라져 문장을 이어 쓸 수 없다 — 편집란은 보이는데
//     편집이 안 되는 상태다. 사람은 이걸 "기능이 없다"로 읽는다.
//  🔴 커서 위치·선택영역·스크롤도 함께 리셋된다(부분 수정이 불가능).
//
// 그래서 계약은 둘로 갈린다:
//  · 편집란의 **값은 사람이 소유한다** — 최초 1회만 서버 override 로 채우고, 이후 응답은 건드리지 않는다.
//  · 설정 변화를 반영해야 하는 것은 **[기본값 보기] 본문뿐**이다(자료 건수·스레드 묶기 여부 등으로 바뀐다).
//
// 러너는 web/ 을 수집하지 않으므로(src/**/*.test.ts 와 kit|scripts|deploy/**/*.test.mjs 만) 브라우저가 실제로
// 싣는 컴파일 산출물 public/app/distillers.js 에서 renderSections 원문을 꺼내 vm 에서 **두 번 호출**한다
// (pjv-taskrow-monkeypatch.test.mjs 동형 — 주변 의존은 최소 스텁으로 세운다).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const JS = readFileSync(join(root, "public/app/distillers.js"), "utf8");

let pass = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };

// ── 산출물에서 함수 원문 꺼내기(중괄호 균형) ────────────────────────────────────
function extract(src, head) {
  const start = src.indexOf(head);
  assert.ok(start >= 0, `산출물에서 '${head}' 를 못 찾았다 — 이름이 바뀌었으면 이 테스트도 함께 고쳐라`);
  let i = src.indexOf("{", start), depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}" && --depth === 0) return src.slice(start, j + 1);
  }
  throw new Error(`'${head}' 의 본문 끝을 못 찾았다`);
}

const RENDER = extract(JS, "function renderSections(views)");
// defText 는 renderSections 밖의 화살표 함수 — 있으면 실제 코드를 그대로 쓴다.
//  ⚠ 없으면 동등한 폴백을 세운다. 하네스가 파싱 실패로 죽으면 **결함이 아니라 하네스 사정으로 red 가 떠서**
//   이 테스트가 무엇을 검증하는지 알 수 없게 된다(실측: 이 폴백 없이 옛 산출물에 돌렸더니 "defText 못 찾음"
//   으로 죽어, 정작 잡아야 할 '편집란 교체'는 확인되지 않았다).
const DEF_TEXT = (JS.match(/const defText = [^\n]+/) || [])[0]
  || "const defText = (v) => v.def || '(이 조각은 지금 설정에선 나가지 않습니다)';";

// ── 최소 DOM 스텁 — el() 은 태그·속성·자식을 받아 가짜 노드를 만든다 ──────────────
function makeCtx() {
  const calls = { replaceChildren: 0 };
  const el = (tag, attrs, ...kids) => {
    const node = {
      tag,
      value: "",
      textContent: attrs && typeof attrs.text === "string" ? attrs.text : "",
      children: kids.filter(Boolean),
      replaceChildren(...c) { calls.replaceChildren++; this.children = c.filter(Boolean); },
    };
    return node;
  };
  const ctx = createContext({
    el,
    SECTION_HINT: { intro: "", criteria: "", format: "", thread: "", procedure: "" },
    sectionInputs: {},
    sectionDefs: {},
    sectionsLoaded: { v: false },
    sectionsHost: el("div"),
    calls,
  });
  runInContext(`${DEF_TEXT}\n${RENDER}`, ctx);
  return ctx;
}

const VIEWS = (defSuffix) => ["intro", "criteria", "format", "thread", "procedure"].map((id) => ({
  id, label: id, editable: true, def: `기본값-${id}-${defSuffix}`, override: undefined,
}));

// ════════ ① 두 번째 갱신이 편집란을 갈아치우지 않는다 (핵심) ════════
{
  const ctx = makeCtx();
  runInContext("renderSections(VIEWS1)", Object.assign(ctx, { VIEWS1: VIEWS("A") }));
  const first = { ...ctx.sectionInputs };
  const firstHostChildren = ctx.sectionsHost.children;
  assert.equal(Object.keys(first).length, 5, "최초 렌더에 조각 편집란 5개가 만들어져야 한다");
  const replaceAfterFirst = ctx.calls.replaceChildren;

  // 사람이 타이핑한 상태를 만든다 — 이 값과 이 **객체**가 살아남아야 한다.
  ctx.sectionInputs.criteria.value = "여신팀 결정만";

  runInContext("renderSections(VIEWS2)", Object.assign(ctx, { VIEWS2: VIEWS("B") }));

  for (const id of Object.keys(first)) {
    assert.equal(ctx.sectionInputs[id], first[id],
      `[${id}] 편집란이 새 객체로 교체됐다 — 타이핑 중이면 포커스·커서가 날아가 편집이 불가능해진다`);
  }
  assert.equal(ctx.sectionInputs.criteria.value, "여신팀 결정만", "사람이 친 값이 갱신에 지워지면 안 된다");
  assert.equal(ctx.calls.replaceChildren, replaceAfterFirst,
    "갱신이 sectionsHost 를 다시 채웠다 — 편집란이 통째로 갈린다(DOM 에서 사라진다)");
  assert.equal(ctx.sectionsHost.children, firstHostChildren, "호스트의 자식 배열도 그대로여야 한다");
  ok("① 미리보기 갱신은 이미 만든 편집란을 교체하지 않는다 (#1557)");
}

// ════════ ② 설정이 바뀌면 [기본값 보기] 본문은 갱신된다 ════════
{
  const ctx = makeCtx();
  runInContext("renderSections(VIEWS1)", Object.assign(ctx, { VIEWS1: VIEWS("A") }));
  assert.equal(ctx.sectionDefs.intro.textContent, "기본값-intro-A");
  runInContext("renderSections(VIEWS2)", Object.assign(ctx, { VIEWS2: VIEWS("B") }));
  assert.equal(ctx.sectionDefs.intro.textContent, "기본값-intro-B",
    "기본값까지 안 바뀌면 '지금 설정에선 이 조각이 이렇게 나간다'가 거짓이 된다");
  assert.equal(ctx.sectionDefs.thread.textContent, "기본값-thread-B");
  ok("② 갱신되어야 할 것([기본값 보기])은 갱신된다");
}

// ════════ ③ 최초 렌더는 서버가 준 override 로 편집란을 채운다(저장된 증류기를 열 때) ════════
{
  const ctx = makeCtx();
  const views = VIEWS("A");
  views[1].override = "저장돼 있던 기준";
  runInContext("renderSections(V)", Object.assign(ctx, { V: views }));
  assert.equal(ctx.sectionInputs.criteria.value, "저장돼 있던 기준",
    "저장된 조각 오버라이드가 안 실리면 사람이 자기가 쓴 걸 못 본다");
  assert.equal(ctx.sectionInputs.intro.value, "", "오버라이드 없는 조각은 비어 있어야 한다(비면 코드 기본값이 나간다)");
  ok("③ 최초 렌더는 저장된 오버라이드를 싣는다");
}

// ════════ ④ 빈 def 는 '지금 설정에선 안 나감'으로 표시된다 ════════
{
  const ctx = makeCtx();
  const views = VIEWS("A");
  views[3].def = "";                      // thread 묶기를 끄면 이 조각은 프롬프트에 안 나간다
  runInContext("renderSections(V)", Object.assign(ctx, { V: views }));
  assert.match(ctx.sectionDefs.thread.textContent, /나가지 않습니다/,
    "빈 기본값을 그대로 비워 두면 '내용이 없는 건지 안 나가는 건지'를 사람이 구분 못 한다");
  ok("④ 지금 설정에서 안 나가는 조각은 그렇게 말한다");
}

console.log(`\n${pass} passed`);
