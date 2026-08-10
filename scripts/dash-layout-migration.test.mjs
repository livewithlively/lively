// 대시보드 배치 저장값 마이그레이션(dashLayout)의 **계약**을 고정한다 (#1596).
//  저장값(localStorage dash_layout_v1)은 곧 그 사람의 화면이다 — 여기가 어긋나면 "숨긴 적 없는데 사라졌다"·
//  "꺼내 뒀는데 도로 들어갔다"가 된다(#1571 실사고). 화면으론 재현이 비싸고 회귀도 눈에 안 보이는 부류라 여기서 본다.
//
//  사양(행위):
//   ① 기본 화면 — 3열은 위 '라이블리 로그'(lvlogd), 아래 '팀 작업 로그'. 브리핑(lvlog)은 기본 숨김.
//   ② 이미 배치를 저장한 사람도 이 교체를 한 번 겪는다(저장값이 곧 화면이라 코드만 바꿔선 안 바뀐다).
//   ③ 교체는 한 번뿐 — 그 뒤 사람이 브리핑을 도로 꺼내 두면 그 선택이 이긴다.
//   ④ 버전 올림이 **과거의 되돌리기를 되살리지 않는다** — 그 사이 사람이 내린 결정을 뒤집게 되므로.
//   ⑤ 저장값이 없거나 깨졌으면 기본 배치(화면이 비지 않는다).
//
//  web/ 는 브라우저 ESM 이라 그대로 import 하면 core.js 의 문서 리스너가 터진다 → 컴파일 산출물
//  (public/app/dash/*.js)에서 레지스트리+두 함수 덩어리만 잘라 평가한다(dash-widget-contracts.test.mjs 와 같은 수법).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const shellFile = "public/app/dash/shell.js";
const prefsFile = "public/app/dash/prefs.js";
const shellSrc = readFileSync(join(root, shellFile), "utf8");
const prefsSrc = readFileSync(join(root, prefsFile), "utf8");

// 레지스트리(DASH_WIDGETS…)부터 dashLayout 본문 끝까지 한 덩어리 — 이 구간은 import 를 안 쓴다(주입 3개로 충분).
function sliceBlock(src, fromDecl, toFn) {
  const start = src.indexOf(fromDecl);
  assert.ok(start >= 0, `${shellFile} 에 ${fromDecl} 이 없습니다 — 이름이 바뀌었다면 이 테스트도 같이 고치세요`);
  const fnAt = src.indexOf(`function ${toFn}(`, start);
  assert.ok(fnAt >= 0, `${shellFile} 에 ${toFn} 이 없습니다`);
  let depth = 0, seen = false;
  for (let i = src.indexOf("{", fnAt); i < src.length; i++) {
    if (src[i] === "{") { depth++; seen = true; }
    else if (src[i] === "}") { depth--; if (seen && depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(`${toFn} 의 본문 끝을 찾지 못했습니다`);
}
const readConst = (name, src, re) => {
  const m = new RegExp(`${name} = ${re}`).exec(src);
  assert.ok(m, `${prefsFile} 에서 ${name} 을 못 읽었습니다`);
  return m[1];
};

const KEY = readConst("DASH_LAYOUT_KEY", prefsSrc, "'([^']+)'");
const VER = Number(readConst("DASH_LAYOUT_VER", prefsSrc, "(\\d+)"));
const body = sliceBlock(shellSrc, "const DASH_WIDGETS = [", "dashLayout");
// 배선 확인 — 추출이 죽어 있으면(빈 덩어리) 아래 표가 통과하면서 아무것도 안 본다.
assert.ok(body.length > 800, "추출이 비었습니다 — 관측 장치가 죽은 채 표만 통과하는 걸 막는다");
assert.ok(VER >= 5, "저장 포맷 버전이 5 미만 — #1596 교체는 버전을 올려야 이미 저장한 사람에게 닿는다");

// 저장값 하나만 들고 있으면 되는 최소 localStorage 스텁 + 읽기 호출 계수(진짜 저장소를 안 건드림도 함께 확인).
let store = null, reads = 0;
const localStorage = {
  getItem: (k) => { reads++; return k === KEY ? store : null; },
  setItem: () => { throw new Error("dashLayout 은 읽기만 해야 한다 — 저장은 사람이 편집할 때만"); },
  removeItem: () => { throw new Error("dashLayout 은 저장값을 지우지 않는다"); },
};
const { dashLayout, DASH_WIDGETS } = new Function(
  "DASH_LAYOUT_KEY", "DASH_LAYOUT_VER", "localStorage",
  `${body}; return { dashLayout, dashDefaultLayout, DASH_WIDGETS };`,
)(KEY, VER, localStorage);

const save = (v, cols, hidden) => { store = JSON.stringify(v == null ? { cols, hidden } : { v, cols, hidden }); };
const count = (arr, k) => arr.filter((x) => x === k).length;
let pass = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };

// ── ① 저장값 없음 = 기본 배치 ──
store = null;
let lay = dashLayout();
assert.deepEqual(lay.cols[2], ["lvlogd", "log"], "3열은 위 '라이블리 로그'(lvlogd), 아래 '팀 작업 로그'(#1596)");
assert.ok(lay.hidden.includes("lvlog"), "'내 라이블리 사용 내역'(브리핑)은 기본 숨김");
assert.deepEqual(lay.cols[0], ["proj", "fold"]);
assert.deepEqual(lay.cols[1], ["notif", "sess"]);
assert.deepEqual(DASH_WIDGETS.filter((w) => w.off).map((w) => w.key).sort(), ["lvlog", "review", "task"]);
ok("① 저장값 없음 — 3열 상단이 '라이블리 로그'");

// ── ② v4 저장값(그 자리에 브리핑) → 교체 ──
save(4, [["proj", "fold"], ["notif", "sess"], ["lvlog", "log"]], ["lvlogd", "review", "task"]);
lay = dashLayout();
assert.deepEqual(lay.cols[2], ["lvlogd", "log"], "브리핑이 있던 자리(3열 상단)를 로그가 이어받는다 — 열 끝이 아니라 **상단**");
assert.ok(lay.hidden.includes("lvlog"), "브리핑은 숨김으로 접힌다");
ok("② v4 저장값 — 브리핑↔로그 교체(자리·순서 포함)");

// ── ③ 버전 구간 밖 단계는 다시 돌지 않는다 ──
//  v4 시점에 사람이 꺼내 둔 '내 할 일'(기본 숨김 위젯)은 v5 로 올라가도 그 자리에 남는다.
save(4, [["proj", "fold", "task"], ["notif", "sess"], ["lvlog", "log"]], ["lvlogd", "review"]);
lay = dashLayout();
assert.ok(lay.cols[0].includes("task"), "사람이 꺼내 둔 '내 할 일'을 버전 올림이 도로 숨기면 안 된다");
assert.ok(!lay.hidden.includes("task"));
ok("③ v4 저장값 — 옛 '기본 숨김 접기'가 다시 발동하지 않는다");

// ── ④ v4 시점에 일부러 숨긴 '최신 알림'도 그대로 숨김(v4 구제는 그 저장값엔 이미 적용 완료) ──
save(4, [["proj", "fold"], ["sess"], ["lvlog", "log"]], ["notif", "lvlogd", "review", "task"]);
lay = dashLayout();
assert.ok(lay.hidden.includes("notif"), "v4 에서 일부러 숨긴 '최신 알림'을 v5 올림이 되꺼내면 안 된다");
assert.ok(!lay.cols.flat().includes("notif"));
ok("④ v4 저장값 — 옛 '최신 알림 구제'가 다시 발동하지 않는다");

// ── ⑤ v5 저장값 — 교체는 한 번뿐, 사람의 선택이 이긴다 ──
save(5, [["proj", "fold"], ["notif", "sess"], ["lvlogd", "lvlog", "log"]], ["review", "task"]);
lay = dashLayout();
assert.deepEqual(lay.cols[2], ["lvlogd", "lvlog", "log"], "v5 이후 사람이 브리핑을 도로 꺼내 뒀으면 그대로 둔다");
assert.ok(!lay.hidden.includes("lvlog"));
ok("⑤ v5 저장값 — 교체는 한 번뿐(사람 선택 보존)");

// ── ⑥ 파손된 저장값 → 기본 배치(화면이 비지 않게) ──
store = "{ 부서진 JSON";
assert.deepEqual(dashLayout().cols[2], ["lvlogd", "log"], "파손된 저장값은 기본 배치로");
ok("⑥ 파손된 저장값 — 기본 배치로 폴백");

// ── ⑦ v 필드가 아예 없는 레거시 저장값 — 전 단계를 다 거치고도 숨김에 중복이 없다 ──
save(null, [["proj", "fold", "review"], ["sess"], ["lvlog", "log"]], ["notif", "lvlogd", "task"]);
lay = dashLayout();
assert.ok(!lay.cols.flat().includes("review"), "옛 저장값의 '검토 대기'는 접힌다(v3 단계)");
assert.ok(lay.cols[1].includes("notif"), "'최신 알림'은 되살아난다(v4 단계)");
assert.deepEqual(lay.cols[2], ["lvlogd", "log"], "3열 상단은 로그(v5 단계)");
assert.equal(count(lay.hidden, "lvlog"), 1, "브리핑이 숨김에 두 번 들어가지 않는다");
ok("⑦ v 필드 부재(레거시) — 세 단계 모두 적용, 중복 없음");

// ── ⑧ v4 인데 사람이 로그를 이미 꺼내 둔 경우 — 중복 삽입 없이 그 자리 유지 ──
save(4, [["proj", "fold"], ["notif", "sess"], ["lvlog", "log", "lvlogd"]], ["review", "task"]);
lay = dashLayout();
assert.equal(count(lay.cols.flat(), "lvlogd"), 1, "이미 꺼내 둔 로그를 한 번 더 끼워 넣지 않는다");
assert.deepEqual(lay.cols[2], ["log", "lvlogd"], "사람이 둔 자리를 옮기지 않는다 — 접는 건 브리핑뿐");
assert.ok(lay.hidden.includes("lvlog"));
ok("⑧ v4 · 로그를 이미 꺼내 둠 — 중복 삽입 없음");

assert.ok(reads >= 8, "매 호출마다 저장값을 실제로 읽었는가(스텁이 배선돼 있는가)");
console.log(`\n${pass} contracts ok`);
