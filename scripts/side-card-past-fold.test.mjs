// #3778 — 홈 목록 **프로젝트 카드 안**에서 무엇이 그대로 서고 무엇이 「지난 세션 n」 뒤로 접히나(안 C).
//
//  신고(원준 2026-09-09): "프로젝트랑 그 프로젝트의 AI 세션들이 사이드바에 쭈르륵 있는데, 지난 세션이
//  되어도 사이드바에서 구분이 안 된다." → 안 C: 카드엔 도는 것만 남기고 끝난 것은 한 줄 뒤로 접는다.
//
//  ★ 이 파일이 지키는 핵심 물음은 원준님이 안을 고르며 바로 던진 그것이다 —
//    "그 경우 지난 세션밖에 없어지면 어케돼?"
//    답: **접지 않는다.** 접힘은 «배경이 본문을 덮지 않게» 하는 장치인데 본문이 없으면 덮을 것도 없다.
//    다 접어 버리면 카드가 뚜껑만 남고, 오늘 한 일이 두 번 클릭 뒤로 숨는다 — #1808·#762 가 고친 그 증상이다.
//
//  시각에 기대지 않는다(이 판정엔 now 가 없다) — 들어온 줄의 past 표식만 본다.
//  홈이 애초에 **오늘 것만** 넘긴다(main.ts workDayStart)는 사실이 이 함수의 전제다.
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const out = mkdtempSync(path.join(tmpdir(), "card-fold-"));
execFileSync(
  path.join(root, "node_modules/.bin/tsc"),
  [path.join(root, "web/lib/sess-fold.ts"), "--outDir", out,
   "--module", "esnext", "--target", "es2022", "--skipLibCheck"],
  { stdio: "inherit" },
);
const { foldCardRows } = await import(path.join(out, "sess-fold.js"));

let pass = 0, fail = 0;
const ok  = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL  ${n} — ${why}`); };
const check = (cond, n, why = "기대와 다르다") => (cond ? ok(n) : bad(n, why));

const ids = (rows) => rows.map((r) => r.id).join(",");
/** 세 자리(now=카드에 그대로 · folded=접힘 뒤 · open=접힘이 열려 있나)를 한 번에 못박는다. */
const lay = (res, wantNow, wantFolded, wantOpen, n) => {
  const gn = ids(res.now), gf = ids(res.folded);
  const wn = wantNow.join(","), wf = wantFolded.join(",");
  check(gn === wn && gf === wf && res.open === wantOpen, n,
    `그대로: 기대 [${wn}] · 실제 [${gn}] / 접힘: 기대 [${wf}] · 실제 [${gf}] / open: 기대 ${wantOpen} · 실제 ${res.open}`);
};

/** 도는(아직 안 끝난) 줄. */
const run  = (id) => ({ id });
/** 끝난 줄 — 홈은 past 표식으로만 이 사실을 넘긴다(main.ts put(…, past)). */
const done = (id) => ({ id, past: true });

// ───────────────────────── A. 기본 — 앞면과 배경이 둘 다 있을 때

lay(foldCardRows([run("도는"), done("끝난")], {}),
  ["도는"], ["끝난"], false,
  "A1 도는 줄은 카드에 그대로 서고 끝난 줄은 접힌다 — 기본은 접힘(원준 2026-08-24)");

lay(foldCardRows([run("a"), run("b"), done("x"), done("y"), done("z")], {}),
  ["a", "b"], ["x", "y", "z"], false,
  "A2 여러 줄도 같은 규칙 — 각 자리 안의 순서는 들어온 그대로다(시간축이 준 순서를 안 흔든다)");

lay(foldCardRows([done("끝난1"), run("도는"), done("끝난2")], {}),
  ["도는"], ["끝난1", "끝난2"], false,
  "A3 끝난 줄이 도는 줄보다 위에 있어도 갈라진다 — 접히는 쪽 안에서는 원래 앞뒤가 유지된다");

// ───────────────────────── B. ★ 원준님 물음 — "지난 세션밖에 없어지면 어케돼?"

lay(foldCardRows([done("끝난1"), done("끝난2"), done("끝난3")], {}),
  ["끝난1", "끝난2", "끝난3"], [], false,
  "B1 ★ 카드에 끝난 줄밖에 없으면 **접지 않는다** — 덮을 본문이 없으면 접힘은 뚜껑일 뿐이고, 오늘 한 일이 두 번 클릭 뒤로 숨는다");

lay(foldCardRows([done("혼자끝남")], {}),
  ["혼자끝남"], [], false,
  "B2 끝난 줄 하나뿐인 카드도 그대로 선다");

lay(foldCardRows([done("끝1"), done("끝2")], { searching: true, opened: true }),
  ["끝1", "끝2"], [], false,
  "B3 전부 끝난 카드는 검색·펼침 상태와 무관하게 접힘 자체가 없다(열 것이 없으니 open 도 거짓)");

{ // 앞면이 하나 생기는 순간 규칙이 뒤집힌다 — 이 경계가 B1 의 반대편이다
  const before = foldCardRows([done("x"), done("y")], {});
  const after  = foldCardRows([run("살아남"), done("x"), done("y")], {});
  check(before.folded.length === 0 && after.folded.length === 2,
    "B4 도는 줄이 하나라도 생기면 그때부터 끝난 줄이 접힌다",
    `앞: folded ${before.folded.length} · 뒤: folded ${after.folded.length}`);
}

// ───────────────────────── C. 접을 것이 없을 때

lay(foldCardRows([run("a"), run("b")], {}),
  ["a", "b"], [], false,
  "C1 끝난 줄이 없으면 접힘 줄을 만들지 않는다(빈 「지난 세션 0」이 서지 않는다)");

lay(foldCardRows([], {}),
  [], [], false,
  "C2 빈 카드는 아무것도 만들지 않는다");

// ───────────────────────── D. 접힘이 저절로 열리는 두 경우

lay(foldCardRows([run("도는"), done("끝난")], { opened: true }),
  ["도는"], ["끝난"], true,
  "D1 사람이 편 카드의 접힘은 열려 있다");

lay(foldCardRows([run("도는"), done("끝난")], { searching: true }),
  ["도는"], ["끝난"], true,
  "D2 검색 중엔 열린다 — 찾으려고 건 렌즈를 접힘이 가리면 안 된다(#1719 와 같은 규율)");

lay(foldCardRows([run("도는"), { id: "보는중", past: true, active: true }], {}),
  ["도는"], ["보는중"], true,
  "D3 ★ 지금 보고 있는 세션이 접히는 쪽에 있으면 열린다 — 보고 있는 화면이 목록에 없으면 그게 고장이다");

lay(foldCardRows([{ id: "보는중", active: true }, done("끝난")], {}),
  ["보는중"], ["끝난"], false,
  "D4 보고 있는 줄이 접히지 않는 쪽에 있으면 접힘은 그대로 닫혀 있다");

// ───────────────────────── E. 줄을 잃거나 겹쳐 세우지 않는다

{
  const rows = [run("r1"), done("p1"), run("r2"), done("p2"), done("p3")];
  const r = foldCardRows(rows, {});
  const got = [...r.now, ...r.folded];
  const missing = rows.filter((x) => !got.includes(x)).map((x) => x.id);
  const dup = got.length !== new Set(got).size;
  check(!missing.length && !dup && got.length === rows.length,
    "E1 모든 줄이 정확히 한 자리에 들어간다(빠지거나 두 번 서지 않는다)",
    `빠짐 [${missing.join(",")}] · 중복 ${dup} · ${got.length}/${rows.length}`);
}

{
  const rows = [run("a"), done("b")];
  const snapshot = ids(rows);
  foldCardRows(rows, {});
  check(ids(rows) === snapshot, "E2 넘긴 배열을 제자리에서 뒤집지 않는다(부르는 쪽의 순서가 남는다)",
    `부른 뒤 [${ids(rows)}]`);
}

console.log(`\nside-card-past-fold: ${pass} passed${fail ? `, ${fail} FAILED` : ""}`);
process.exit(fail ? 1 : 0);
