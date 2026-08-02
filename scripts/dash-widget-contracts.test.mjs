// 대시보드 대형 위젯의 **identity 계약** 2건을 고정한다 (#1313 R42 · dashboard-home.ts 분해 ②).
//  둘 다 "화면은 멀쩡한데 나중에 조용히 어긋나는" 부류라, 사람이 눈으로 재현하기 비싸고 회귀도 잘 안 보인다.
//
// ① 세션 위젯 헤더의 필터 칩 노드(fdd) — draw() 를 다시 돌려도 **같은 DOM 노드**여야 한다.
//    틀렸을 때 실제로 났던 일(#1098): 필터 팝오버를 열고 항목을 하나 고르면 draw() 가 돌고, 그때 칩을
//    새로 만들어 갈아끼우면 팝오버의 **앵커가 문서에서 사라진다** → dashPopover 의 바깥클릭 감지가 다음
//    클릭을 '팝오버 밖'으로 오판해 두 번째 항목을 고르는 순간 팝오버가 닫혔다(다중선택이 불가능해짐).
//    그래서 sessPaintFilterChip 은 (a) 라벨/클래스만 갱신하고 (b) 이미 첫 자식이면 재부착도 건너뛴다.
// ② 프로젝트 위젯의 listById — 새로고침해도 **같은 Map 객체**여야 한다.
//    행(projRow)이 만든 상태 컨트롤은 이 Map 을 캡처해 두고 나중에 읽는다. `new Map(...)` 으로 갈아끼우면
//    이미 그려진 행들이 옛 Map 을 계속 보게 돼 리스트 이름·커스텀 상태 어휘가 옛 값으로 굳는다.
//
//  web/ 는 브라우저 ESM 이라 그대로 import 하면 core.js 의 문서 리스너가 터진다 → 컴파일 산출물
//  (public/app/dash/*.js)에서 함수 선언 한 덩어리만 잘라 평가한다(terminal-mouse-stale.test.mjs 와 같은 수법).
//  이 두 함수가 '순수하게 ctx 만 만지는' 상태로 남아야 한다는 것도 그래서 여기서 함께 강제된다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// 함수 선언 한 덩어리만 추출 — 중괄호 깊이로 끝을 찾는다(정규식으로 끝을 맞추려 들면 본문의 } 를 만나 깨진다).
function extractFn(src, file, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${file} 에 ${name} 이 없습니다 — 이름이 바뀌었다면 이 테스트도 같이 고치세요`);
  let depth = 0, seen = false;
  for (let i = src.indexOf("{", start); i < src.length; i++) {
    if (src[i] === "{") { depth++; seen = true; }
    else if (src[i] === "}") { depth--; if (seen && depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(`${name} 의 본문 끝을 찾지 못했습니다`);
}

let pass = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };

// ── ① 필터 칩 노드 identity ──
const sessFile = "public/app/dash/widget-sessions.js";
const sessSrc = readFileSync(join(root, sessFile), "utf8");
const paintSrc = extractFn(sessSrc, sessFile, "sessPaintFilterChip");
// 배선 확인 — 추출이 죽어 있으면(빈 함수) 아래 표가 통과하면서 아무것도 안 본다.
assert.ok(paintSrc.length > 120, "sessPaintFilterChip 추출이 비었습니다 — 관측 장치가 죽은 채 표만 통과하는 걸 막는다");
assert.match(paintSrc, /firstChild !== ctx\.fdd/, "재부착 가드(firstChild !== fdd)가 사라졌습니다 — 계약①");
// 자유변수 sessFilterLabel(원본은 widget-sessions-popovers 의 import)은 전역 스텁으로 대신한다.
globalThis.sessFilterLabel = (ctx) => (ctx.fSrc.size + ctx.fState.size ? `조건 ${ctx.fSrc.size + ctx.fState.size}개` : "전체");
const sessPaintFilterChip = new Function(`${paintSrc}; return sessPaintFilterChip;`)();
assert.equal(typeof sessPaintFilterChip, "function");

// 최소 DOM 스텁 — 우리가 보는 것은 '노드를 갈아끼웠는가'뿐이라 필요한 표면만 흉내 낸다.
function mkChips() {
  return { firstChild: null, replaceCalls: 0, replaceChildren(n) { this.replaceCalls++; this.firstChild = n; } };
}
function mkCtx() {
  const fddLbl = { textContent: "전체" };
  const fdd = { classList: { on: false, toggle(_c, v) { this.on = !!v; } } };
  const chipsEl = mkChips();
  return { fdd, fddLbl, chipsEl, fSrc: new Set(), fState: new Set(), zone: { chipsEl } };
}

const ctx = mkCtx();
const chipNode = ctx.fdd; // 뒤에서 '같은 노드인가'를 볼 기준
sessPaintFilterChip(ctx);
assert.equal(ctx.chipsEl.replaceCalls, 1, "첫 draw 는 칩을 헤더에 한 번 붙인다");
assert.equal(ctx.chipsEl.firstChild, chipNode, "붙은 것은 fillSessions 가 만든 바로 그 칩이어야 한다");
ok("①-1 첫 렌더 — 칩을 한 번 붙인다");

ctx.fSrc.add("myproj");
sessPaintFilterChip(ctx);
ctx.fState.add("busy");
sessPaintFilterChip(ctx);
assert.equal(ctx.chipsEl.replaceCalls, 1, "다시 그려도 재부착하지 않는다 — 팝오버 앵커가 살아 있어야 한다(#1098)");
assert.equal(ctx.chipsEl.firstChild, chipNode, "여러 번 다시 그려도 헤더에 있는 노드는 **같은 객체**여야 한다");
assert.equal(ctx.fdd, chipNode, "ctx.fdd 자체도 교체되지 않는다");
ok("①-2 재렌더 — 노드 identity 유지(재부착 0회)");

assert.equal(ctx.fddLbl.textContent, "조건 2개", "라벨은 노드를 바꾸지 않고 textContent 만 갱신한다");
assert.equal(ctx.fdd.classList.on, true, "조건이 걸리면 칩에 on 클래스가 선다");
ctx.fSrc.clear(); ctx.fState.clear();
sessPaintFilterChip(ctx);
assert.equal(ctx.fddLbl.textContent, "전체", "조건을 비우면 라벨이 '전체'로 돌아온다");
assert.equal(ctx.fdd.classList.on, false, "조건이 없으면 on 이 풀린다");
assert.equal(ctx.chipsEl.replaceCalls, 1, "라벨만 바뀌는 동안에도 재부착은 없다");
ok("①-3 라벨·on 만 갱신(노드 교체 없음)");

// 가드가 살아 있는지(죽은 코드가 아닌지) 반대 방향으로 확인 — 남이 칩 자리를 빼앗으면 다시 붙인다.
ctx.chipsEl.firstChild = { notTheChip: true };
sessPaintFilterChip(ctx);
assert.equal(ctx.chipsEl.replaceCalls, 2, "칩이 헤더에서 밀려났으면 그때는 다시 붙여야 한다");
assert.equal(ctx.chipsEl.firstChild, chipNode, "되붙일 때도 새 노드가 아니라 같은 칩을 붙인다");
ok("①-4 재부착 가드는 죽은 코드가 아니다(밀려나면 되붙음)");

// ── ② listById Map 참조 유지 ──
const projFile = "public/app/dash/widget-projects.js";
const projSrc = readFileSync(join(root, projFile), "utf8");
const refillSrc = extractFn(projSrc, projFile, "projRefillListById");
assert.ok(refillSrc.length > 60, "projRefillListById 추출이 비었습니다");
assert.doesNotMatch(refillSrc, /new Map/, "listById 를 새로 만들면 이미 그려진 행이 옛 Map 을 계속 본다 — 계약②");
const projRefillListById = new Function(`${refillSrc}; return projRefillListById;`)();

const listById = new Map([[1, { id: 1, name: "옛 이름" }]]);
const captured = listById; // 행이 캡처해 둔 참조(= projRow 가 dashProjStatusControl 에 넘긴 것)
const pctx = { listById, lists: [{ id: 1, name: "새 이름" }, { id: 2, name: "새로 생긴 리스트" }] };
projRefillListById(pctx);
assert.equal(pctx.listById, captured, "새로고침해도 **같은 Map 객체**여야 한다");
assert.equal(captured.get(1).name, "새 이름", "캡처한 참조로도 갱신된 이름이 읽혀야 한다");
assert.equal(captured.get(2).name, "새로 생긴 리스트", "새로 생긴 리스트도 캡처한 참조로 보인다");
assert.equal(captured.size, 2, "사라진 리스트는 남지 않는다(clear 후 재적재)");
ok("②-1 listById — 같은 Map 참조를 비우고 다시 채운다");

console.log(`\n${pass} contracts ok`);
