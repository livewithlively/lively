// 대시보드 배치 저장값 이관(dashLayout) 계약 (#1715).
//  기본 배치가 바뀔 때마다 손대는 자리인데, 틀려도 화면은 멀쩡해 보인다 — 어긋남은 **이미 저장된 배치를 가진
//  사람에게만** 나타나고(고친 사람 브라우저엔 대개 저장값이 없다), 그 사람 눈엔 "숨긴 적 없는데 사라졌다"로 온다.
//  고정하는 것 넷:
//   ① 기본 배치 — 저장값이 없으면 3열 상단은 '라이블리 로그'(lvlogd), 브리핑(lvlog)은 숨김(#1715).
//   ② 판(ver)마다 한 번 — 그 판에서 승격/강등된 위젯만 손보고, 나머지는 사람이 둔 자리를 그대로 둔다.
//   ③ 두 번은 없다 — 이관을 겪은 뒤 사람이 정한 상태는 다음 판에서 되돌려지지 않는다.
//   ④ 승격은 **기본 자리(순서 포함)** 로 — 열 끝에 붙이면 새 기본이 맨 아래로 들어간다.
//  ②가 이 파일이 생긴 이유다: 예전 이관은 '버전이 다르기만 하면 off 위젯을 전부 숨김으로' 되돌려서,
//  '검토 대기'를 일부러 꺼내 둔 사람이 판이 오를 때마다 그걸 잃었다.
//
//  web/ 는 브라우저 ESM 이라 그대로 import 하면 core.js 의 문서 리스너가 터진다 → 컴파일 산출물
//  (public/app/dash/*.js)에서 필요한 선언 덩어리만 잘라 평가한다(dash-widget-contracts.test.mjs 와 같은 수법).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const shellFile = "public/app/dash/shell.js";
const shellSrc = readFileSync(join(root, shellFile), "utf8");
const prefsSrc = readFileSync(join(root, "public/app/dash/prefs.js"), "utf8");

// 레지스트리 ~ dashLayout 까지 한 덩어리(중괄호 깊이로 dashLayout 의 끝을 찾는다).
const start = shellSrc.indexOf("const DASH_WIDGETS = [");
assert.ok(start >= 0, `${shellFile} 에 DASH_WIDGETS 가 없습니다 — 이름이 바뀌었다면 이 테스트도 같이 고치세요`);
const fnStart = shellSrc.indexOf("function dashLayout()", start);
assert.ok(fnStart > start, `${shellFile} 에 dashLayout() 이 없습니다`);
let depth = 0, seenBrace = false, end = -1;
for (let i = shellSrc.indexOf("{", fnStart); i < shellSrc.length; i++) {
  if (shellSrc[i] === "{") { depth++; seenBrace = true; }
  else if (shellSrc[i] === "}") { depth--; if (seenBrace && depth === 0) { end = i + 1; break; } }
}
assert.ok(end > 0, "dashLayout 의 본문 끝을 찾지 못했습니다");
const chunk = shellSrc.slice(start, end);
// 배선 확인 — 추출이 죽어 있으면(빈 덩어리) 아래 표가 통과하면서 아무것도 안 본다.
assert.ok(chunk.length > 1000, "추출이 비었습니다 — 관측 장치가 죽은 채 표만 통과하는 걸 막는다");

// 저장 키·판 번호는 prefs.js 소유(shell 이 import 한다) — 실제 값을 그대로 읽어 쓴다.
const VER = Number((prefsSrc.match(/const DASH_LAYOUT_VER = (\d+)/) || [])[1]);
const KEY = (prefsSrc.match(/const DASH_LAYOUT_KEY = '([^']+)'/) || [])[1];
assert.ok(Number.isInteger(VER) && VER >= 5, `DASH_LAYOUT_VER 를 읽지 못했거나 판이 올라가지 않았습니다(${VER}) — 기본 배치를 바꾸면 판을 올려야 이관이 걸린다`);
assert.ok(KEY, "DASH_LAYOUT_KEY 를 읽지 못했습니다");

// localStorage 스텁 — dashLayout 은 읽기만 한다. 다른 키를 물으면 null(그 자체가 배선 확인).
let store = null;
globalThis.localStorage = { getItem: (k) => (k === KEY ? store : null) };
const dashLayout = new Function("DASH_LAYOUT_KEY", "DASH_LAYOUT_VER", `${chunk}; return dashLayout;`)(KEY, VER);
const layoutOf = (saved) => { store = typeof saved === "string" || saved === null ? saved : JSON.stringify(saved); return dashLayout(); };
const DEFAULT_COLS = [["proj", "fold"], ["notif", "sess"], ["lvlogd", "log"]];

let pass = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };

// ── ①② 기본 배치 · 파손 내성 ──
{
  const lay = layoutOf(null);
  assert.deepEqual(lay.cols, DEFAULT_COLS, "3열 = 위 '라이블리 로그' · 아래 '팀 작업 로그'(#1715)");
  assert.ok(lay.hidden.includes("lvlog"), "'내 라이블리 사용 내역'은 기본 숨김(#1715)");
  assert.ok(lay.hidden.includes("review") && lay.hidden.includes("task"), "검토 대기·내 할 일도 기본 숨김");
  assert.ok(!lay.hidden.includes("lvlogd"), "'라이블리 로그'는 기본 표시");
  assert.deepEqual(layoutOf("{ 이건 JSON 이 아니다").cols, DEFAULT_COLS, "파손된 저장값은 기본 배치로");
  assert.deepEqual(layoutOf({ v: VER, cols: "배열이 아님" }).cols, DEFAULT_COLS, "형식이 다르면 기본 배치로");
  ok("①② 저장값 없음·파손 — 3열 상단이 '라이블리 로그', 브리핑은 숨김");
}

// ── ③④ v4 저장값 이관 — 브리핑↔로그 자리 교대(승격은 열 끝이 아니라 기본 순서 자리로) ──
{
  const lay = layoutOf({ v: 4, cols: [["proj", "fold"], ["notif", "sess"], ["lvlog", "log"]], hidden: ["lvlogd", "review", "task"] });
  assert.deepEqual(lay.cols[2], ["lvlogd", "log"], "숨김에 있던 '라이블리 로그'가 기본 자리(3열 **상단**)로 온다 — 열 끝이 아니다");
  assert.ok(lay.hidden.includes("lvlog"), "기본 숨김이 된 브리핑은 열에서 빠져 숨김으로");
  assert.ok(!lay.hidden.includes("lvlogd"));
  assert.ok(lay.hidden.includes("review") && lay.hidden.includes("task"), "다른 숨김 위젯은 그대로");
  ok("③④ v4 저장값 — 3열 상단이 로그로 교대, 브리핑은 숨김으로");
}

// ── ⑤ 판마다 한 번 — 일부러 꺼내 둔 위젯은 이관이 건드리지 않는다(#1715 회귀) ──
{
  const lay = layoutOf({ v: 4, cols: [["proj", "review", "fold"], ["notif", "sess", "task"], ["lvlog", "log"]], hidden: ["lvlogd"] });
  assert.deepEqual(lay.cols[0], ["proj", "review", "fold"], "v4 에서 직접 꺼내 둔 '검토 대기'는 그 자리 그대로 — 판이 올랐다고 뺏지 않는다");
  assert.deepEqual(lay.cols[1], ["notif", "sess", "task"], "'내 할 일'도 마찬가지");
  assert.deepEqual(lay.cols[2], ["lvlogd", "log"], "이번 판에서 바뀐 위젯만 손본다");
  ok("⑤ 이관은 그 판에서 바뀐 위젯만 — 사람이 둔 자리는 유지");
}

// ── ⑥ 두 번은 없다 — 이관 뒤 사람이 다시 정한 상태(최신 판)는 그대로 ──
{
  const lay = layoutOf({ v: VER, cols: [["proj", "fold"], ["notif", "sess"], ["lvlog", "log"]], hidden: ["lvlogd", "review", "task"] });
  assert.ok(lay.hidden.includes("lvlogd"), "최신 판으로 저장한 사람이 숨긴 '라이블리 로그'는 도로 튀어나오지 않는다");
  assert.deepEqual(lay.cols[2], ["lvlog", "log"], "최신 판에서 직접 꺼내 둔 브리핑도 그 자리 그대로");
  ok("⑥ 최신 판 저장값 — 이관이 다시 걸리지 않는다");
}

// ── ⑦ 초창기(판 번호 없음·이상한 값) — 그동안의 이관이 누적으로 걸린다 ──
for (const v of [undefined, null, "abc"]) {
  const lay = layoutOf({ v, cols: [["proj", "fold", "task"], ["notif", "sess"], ["lvlog", "log", "review"]], hidden: [] });
  for (const k of ["task", "review", "lvlog"]) assert.ok(lay.hidden.includes(k), `v=${String(v)}: ${k} 는 그 뒤 판에서 기본 숨김이 됐다`);
  assert.deepEqual(lay.cols[2], ["lvlogd", "log"], `v=${String(v)}: 3열 상단은 로그`);
}
ok("⑦ 판 번호가 없거나 숫자가 아니면 0 취급 — 누적 이관");

// ── ⑧⑨ '최신 알림' 구제(v4)의 경계 — v4 이전에만 한 번 ──
{
  const before = layoutOf({ v: 3, cols: [["proj", "fold"], ["sess"], ["review", "log"]], hidden: ["notif"] });
  assert.deepEqual(before.cols[1], ["notif", "sess"], "v3 이전 저장값이면 '최신 알림'을 기본 자리(가운데 열 상단)로 되꺼낸다");
  assert.deepEqual(before.cols[2], ["review", "lvlogd", "log"], "v3 에서 직접 꺼내 둔 '검토 대기'는 유지(경계 3>=3) · 로그는 팀로그 앞에");
  const after = layoutOf({ v: 4, cols: [["proj", "fold"], ["sess"], ["log"]], hidden: ["notif"] });
  assert.ok(after.hidden.includes("notif"), "v4 로 저장한 사람이 숨긴 '최신 알림'은 다시 꺼내지 않는다 — 구제는 반복되지 않는다");
  ok("⑧⑨ 최신 알림 구제 경계 — v4 이전만(v4 저장값은 사람 뜻)");
}

// ── ⑩ 승격 대상이 이미 열에 있으면 자리를 옮기지 않는다(새 이관 헬퍼의 '부재' 엣지) ──
{
  const lay = layoutOf({ v: 4, cols: [["lvlogd", "proj", "fold"], ["notif", "sess"], ["lvlog", "log"]], hidden: [] });
  assert.deepEqual(lay.cols[0], ["lvlogd", "proj", "fold"], "미리 왼쪽 열에 꺼내 둔 '라이블리 로그'를 3열로 끌고 오지 않는다");
  assert.deepEqual(lay.cols[2], ["log"], "브리핑만 빠지고 기본 자리 삽입은 일어나지 않는다");
  ok("⑩ 승격 이관은 숨김에 있을 때만 — 열에 있으면 그 자리 유지");
}

// ── ⑪⑫ 강등 경계 — '내 할 일'은 v2 부터 기본 숨김 ──
{
  const v1 = layoutOf({ v: 1, cols: [["proj", "task", "fold"], ["notif", "sess"], ["log"]], hidden: [] });
  assert.ok(v1.hidden.includes("task"), "v1(<2) 저장값의 '내 할 일'은 숨김으로 되돌린다");
  const v2 = layoutOf({ v: 2, cols: [["proj", "task", "fold"], ["notif", "sess"], ["log"]], hidden: [] });
  assert.deepEqual(v2.cols[0], ["proj", "task", "fold"], "v2(>=2) 저장값의 '내 할 일'은 사람이 꺼낸 것 — 그대로");
  assert.ok(v2.hidden.includes("review") && v2.hidden.includes("lvlog"), "그 뒤 판의 강등(검토 v3·브리핑 v5)은 여전히 걸린다");
  ok("⑪⑫ 강등 경계 — 저장 판 == 강등 판이면 건너뛴다");
}

// ── ⑬⑭⑮ 정규화 내성(기존 계약) — 모르는 키·중복·4열 이상·숨김 중복 ──
{
  const lay = layoutOf({ v: VER, cols: [["proj", "nope", "proj"], ["notif"], []], hidden: ["zzz"] });
  assert.deepEqual(lay.cols[0], ["proj", "fold"], "모르는 키는 버리고 중복은 첫 자리만 · 빠진 위젯은 기본 자리로");
  assert.ok(!lay.hidden.includes("zzz"), "모르는 키는 숨김에도 남지 않는다");
  const wide = layoutOf({ v: VER, cols: [["proj", "fold"], ["notif", "sess"], ["log"], ["lvlogd"]], hidden: [] });
  assert.deepEqual(wide.cols[2], ["log", "lvlogd"], "4열 이상 저장값은 넘치는 열을 3열 끝으로 흡수 — 위젯이 사라지지 않는다");
  const dup = layoutOf({ v: 4, cols: [["proj", "fold"], ["notif", "sess"], ["log"]], hidden: ["lvlog"] });
  assert.equal(dup.hidden.filter((k) => k === "lvlog").length, 1, "이미 숨김인 위젯을 강등이 또 밀어 넣지 않는다");
  ok("⑬⑭⑮ 모르는 키·중복·4열 이상·숨김 중복 내성");
}

console.log(`\n${pass} contracts ok`);
