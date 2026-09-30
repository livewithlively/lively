// #3870 — 이름 입력칸이 열려 있는 동안 그 자리를 다시 그리지 않는다(lib/edit-hold) · 사이드바와 문패가 그걸 쓴다.
//
//  원준 2026-09-30 신고: "더블클릭해서 사이드바에서 프로젝트 이름 수정하려고 함 -> 몇 초 있다가 다시 이전으로 돌아와서
//   몇 초 안에 타이핑 쳐야 함. 터미널 세션 위에 있는 프로젝트 이름 수정도 마찬가지."
//  매니지드 실측(쓰기 차단 헤드리스 · 칸을 뜯어낸 호출의 스택):
//   · 문패: 8초 라이브 틱 → paintDoor → door.replaceChildren (연 지 1.8~2.3초에 칸이 사라짐)
//   · 사이드바: watchLastAsk → repaintList → paintList → replaceChildren (render() 의 가드가 이 붓엔 없었다)
//   · 크롬은 뜯긴 칸에 blur 를 쏘고 두 편집기 모두 blur = 저장이라, 치던 글자가 Enter 없이 저장 요청으로 나갔다.
//
//  A. 판정(lib/edit-hold) — 엣지 표 H1~H12, 행마다 단언 하나 이상.
//  B. 배선 — 다시 그리는 붓이 모두 먼저 묻는가(side.ts render·repaintList · panes.ts paintDoor), 편집기가 칸을 쥐고 놓는가.
//  fail-first(2026-09-30): 변경 전 side.ts·panes.ts 로 B 가 빨강, lib 변이(skip 이 빚을 안 적음 · end 가 누름을 안 기다림 ·
//   end 가 남의 칸을 놓음 · paid 무시 · 갚기를 동기로)마다 A 의 해당 행이 빨강이었다(EDIT_HOLD_SRC·SIDE_SRC·PANES_SRC 로 물려 확인).
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const out = mkdtempSync(path.join(tmpdir(), "edit-hold-"));
const LIB = process.env.EDIT_HOLD_SRC || path.join(root, "web/lib/edit-hold.ts");
execFileSync(
  path.join(root, "node_modules/.bin/tsc"),
  [LIB, "--outDir", out, "--module", "esnext", "--target", "es2022", "--skipLibCheck", "--lib", "es2022,dom"],
  { stdio: "inherit" },
);
const { editHold } = await import(path.join(out, path.basename(LIB).replace(/\.ts$/, ".js")));

let pass = 0, fail = 0;
const ok  = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL  ${n} — ${why}`); };
const check = (cond, n, why = "기대와 다르다") => (cond ? ok(n) : bad(n, why));

//  가짜 환경 — 문서의 누름·뗌을 손으로 쏘고, «다음 차례» 는 큐에 쌓았다가 flush() 로 돌린다(동기로 부르면 안 된다는 것까지 잰다).
function env() {
  const ears = { pointerdown: [], pointerup: [], pointercancel: [] };
  const queue = [];
  let listens = 0;
  return {
    listen(type, fn) { listens++; ears[type].push(fn); },
    later(fn) { queue.push(fn); },
    fire(type) { for (const fn of ears[type]) fn(); },
    flush() { while (queue.length) queue.shift()(); },
    get queued() { return queue.length; },
    get listens() { return listens; },
  };
}
const node = () => ({ isConnected: true });
const counter = () => { const f = () => { f.n++; }; f.n = 0; return f; };

// ───────────────────────── A. 판정

{ // H1 편집 중엔 건너뛴다
  const e = env(); const h = editHold(e); const inp = node();
  check(!h.alive() && h.skip() === false, "H1a 아무도 안 고치면 그린다(skip=false)");
  h.begin(inp);
  check(h.alive() && h.skip() === true, "H1b ★★ 칸이 붙어 있는 동안 skip()=true — 다시 그리지 않는다");
}
{ // H2 스스로 낫는 판정(#2579)
  const e = env(); const h = editHold(e); const inp = node();
  h.begin(inp); inp.isConnected = false;
  check(!h.alive() && h.skip() === false, "H2 ★ 칸이 뜯겨 나가면 판정이 풀린다 — 불리언처럼 굳지 않는다");
}
{ // H3 빚이 없으면 갚지 않는다
  const e = env(); const h = editHold(e); const inp = node(); const pay = counter();
  h.begin(inp); inp.isConnected = false; h.end(inp, pay); e.flush();
  check(pay.n === 0, "H3 편집 중 건너뛴 그리기가 없으면 끝나도 다시 그리지 않는다", `pay=${pay.n}`);
}
{ // H4 건너뛴 그리기는 끝난 뒤 한 번 갚는다 — 다음 차례에
  const e = env(); const h = editHold(e); const inp = node(); const pay = counter();
  h.begin(inp); h.skip(); h.skip(); h.skip();
  inp.isConnected = false; h.end(inp, pay);
  check(pay.n === 0, "H4a 끝내는 그 자리에서 동기로 그리지 않는다(blur·keydown 한가운데)", `pay=${pay.n}`);
  e.flush();
  check(pay.n === 1, "H4b ★★ 여러 번 건너뛰어도 끝나면 **한 번** 갚는다", `pay=${pay.n}`);
  h.end(inp, pay); e.flush();
  check(pay.n === 1, "H4c 이미 갚았으면 다시 끝내도 안 그린다", `pay=${pay.n}`);
}
{ // H5 전부 다시 그린 쪽이 빚을 지운다(저장 경로 — 셸이 새 이름으로 다시 그린다)
  const e = env(); const h = editHold(e); const inp = node(); const pay = counter();
  h.begin(inp); h.skip(); inp.isConnected = false;
  check(h.skip() === false, "H5a 칸이 떨어진 뒤의 그리기는 통과한다");
  h.paid(); h.end(inp, pay); e.flush();
  check(pay.n === 0, "H5b ★ paid() 뒤엔 갚을 게 없다 — 같은 걸 두 번 그리지 않는다", `pay=${pay.n}`);
}
{ // H6 누르던 손을 뗀 뒤에 갚는다 — 떼기 전에 갈아 끼우면 그 클릭이 사라진다
  const e = env(); const h = editHold(e); const inp = node(); const pay = counter();
  h.begin(inp); h.skip();
  e.fire("pointerdown");                          // 다른 줄을 누른다 → blur → 편집 끝
  inp.isConnected = false; h.end(inp, pay); e.flush();
  check(pay.n === 0, "H6a ★★ 누르는 동안엔 갚지 않는다", `pay=${pay.n}`);
  e.fire("pointerup");
  check(pay.n === 0, "H6b 뗀 그 사건 안에서도 아니다(click 이 아직 안 갔다)", `pay=${pay.n}`);
  e.flush();
  check(pay.n === 1, "H6c 뗀 다음 차례에 한 번 갚는다", `pay=${pay.n}`);
}
{ // H7 pointercancel 도 손을 뗀 것이다
  const e = env(); const h = editHold(e); const inp = node(); const pay = counter();
  h.begin(inp); h.skip(); e.fire("pointerdown"); inp.isConnected = false; h.end(inp, pay);
  e.fire("pointercancel"); e.flush();
  check(pay.n === 1, "H7 pointercancel 뒤에도 갚는다(터치 스크롤 등)", `pay=${pay.n}`);
}
{ // H8 갚기 전에 새 편집이 열리면 빚은 그 편집으로 넘어간다
  const e = env(); const h = editHold(e); const a = node(); const b = node(); const pay = counter();
  h.begin(a); h.skip(); a.isConnected = false; h.end(a, pay);
  h.begin(b); e.flush();
  check(pay.n === 0 && h.alive(), "H8a ★ 새 칸이 열려 있으면 갚지 않는다(갚으면 새 칸이 뜯긴다)", `pay=${pay.n}`);
  b.isConnected = false; h.end(b, pay); e.flush();
  check(pay.n === 1, "H8b 새 편집이 끝나면 넘겨받은 빚을 갚는다", `pay=${pay.n}`);
}
{ // H9 늦게 끝난 옛 편집이 새 칸을 놓지 않는다(저장 응답을 기다리는 사이 새 편집)
  const e = env(); const h = editHold(e); const a = node(); const b = node();
  h.begin(a); a.isConnected = false; h.begin(b); h.end(a);
  check(h.alive() && h.skip() === true, "H9 ★ end(옛 칸) 은 지금 열린 칸을 놓지 않는다");
}
{ // H10 pay 없이 끝내면 놓기만 한다(문패 — 곧바로 스스로 다시 그린다)
  const e = env(); const h = editHold(e); const inp = node();
  h.begin(inp); h.skip(); h.end(inp);
  check(!h.alive() && h.skip() === false, "H10a ★ 칸이 아직 붙어 있어도 놓은 뒤엔 그린다 — 문패가 제 칸을 걷을 수 있다");
  check(e.queued === 0, "H10b pay 가 없으면 아무것도 예약하지 않는다", `queued=${e.queued}`);
}
{ // H11 누름 귀는 문서(환경)마다 한 벌 — 편집기가 탭마다 서도 쌓이지 않는다
  const e = env(); const hs = [editHold(e), editHold(e), editHold(e)];
  for (const h of hs) { const n = node(); h.begin(n); h.begin(n); }
  check(e.listens === 3, "H11 ★ 편집기 셋이 몇 번을 열어도 문서 귀는 pointerdown·up·cancel 셋뿐", `listens=${e.listens}`);
}
{ // H12 두 편집기는 누름은 나누되 빚은 따로 — 한쪽을 갚느라 다른 쪽을 그리지 않는다
  const e = env(); const side = editHold(e); const door = editHold(e); const a = node(); const b = node();
  const payA = counter(), payB = counter();
  side.begin(a); door.begin(b); side.skip();
  e.fire("pointerdown"); a.isConnected = false; side.end(a, payA); b.isConnected = false; door.end(b, payB);
  e.fire("pointerup"); e.flush();
  check(payA.n === 1 && payB.n === 0, "H12 빚은 편집기마다 따로 — 건너뛴 쪽만 갚는다", `A=${payA.n} B=${payB.n}`);
}

// ───────────────────────── B. 배선 — 주석을 걷고 본다(설명 주석의 낱말이 거짓 초록·빨강을 내지 않게)

const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "").replace(/[ \t]\/\/[^'"\n]*$/gm, "");
const SIDE = code(readFileSync(process.env.SIDE_SRC || path.join(root, "web/v2/side.ts"), "utf8"));
const PANES = code(readFileSync(process.env.PANES_SRC || path.join(root, "web/v2/panes.ts"), "utf8"));
/** `function name(...) {` 부터 짝이 맞는 `}` 까지 */
function body(src, name) {
  const i = src.search(new RegExp(`function ${name}\\s*\\(`));
  if (i < 0) return "";
  const j = src.indexOf("{", src.indexOf(")", i));
  let d = 0;
  for (let k = j; k < src.length; k++) {
    if (src[k] === "{") d++;
    else if (src[k] === "}" && --d === 0) return src.slice(i, k + 1);
  }
  return "";
}
const firstStmt = (fn) => fn.slice(fn.indexOf("{", fn.indexOf(")")) + 1).trim();

{
  const rl = body(SIDE, "repaintList");
  check(rl.length > 0 && /^if \(renaming\.skip\(\)\) return;/.test(firstStmt(rl)),
    "W1 ★★ side.ts repaintList 가 목록을 갈기 전에 renaming.skip() 을 먼저 묻는다(last-ask 도착 경로)", firstStmt(rl).slice(0, 80));
  const r = body(SIDE, "render");
  const skipAt = r.indexOf("if (renaming.skip()) return;");
  check(skipAt > 0 && /if \(renaming\.skip\(\)\) return;\s*renaming\.paid\(\);/.test(r) && skipAt < r.indexOf("renderSourcesSection()"),
    "W2 ★ side.ts render() 는 구역을 그리기 전에 묻고 — 건너뛸 땐 빚을 적고, 그릴 땐 paid() 로 지운다");
  const ir = body(SIDE, "inlineRename");
  check(/renaming\.begin\(input\)/.test(ir), "W3a side.ts inlineRename 이 연 칸을 쥔다(begin)");
  check((ir.match(/renaming\.end\(input, redraw\)/g) || []).length === 2,
    "W3b ★ 취소·저장 두 경로 모두 끝나면 칸을 놓고 건너뛴 그리기를 갚는다", String((ir.match(/renaming\.end\(/g) || []).length));
  check(!/renamingAlive|renamingEl\b/.test(SIDE), "W3c 옛 판정(renamingEl·renamingAlive)이 남아 두 판정이 갈라지지 않는다");
}
{
  const pd = body(PANES, "paintDoor");
  check(pd.length > 0 && /^if \(titleEdit\.skip\(\)\) return;\s*titleEdit\.paid\(\);/.test(firstStmt(pd)),
    "W4 ★★ panes.ts paintDoor 가 문패를 갈기 전에 titleEdit.skip() 을 먼저 묻는다(8초 틱 경로)", firstStmt(pd).slice(0, 80));
  const sr = body(PANES, "startRenameProject");
  check(/host\.replaceChildren\(input\);\s*titleEdit\.begin\(input\);/.test(sr), "W5a 문패 편집기가 연 칸을 쥔다(begin)");
  check(/closed = true; titleEdit\.end\(input\); paintDoor\(\);/.test(sr),
    "W5b ★ 취소는 칸을 **놓은 뒤에** 문패를 다시 그린다(놓기 전엔 paintDoor 가 건너뛰어 칸이 안 걷힌다)");
  check(/closed = true; input\.disabled = true; titleEdit\.end\(input\);/.test(sr),
    "W5c 저장은 응답을 기다리기 전에 칸을 놓는다 — 응답이 안 와도 문패가 굳지 않는다");
  check(/const titleEdit = editHold\(\);/.test(PANES), "W5d 문패 편집기는 판마다 제 것을 쥔다");
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
