// #4084 곁칸 «태스크» 부품 — **무엇을 어디에 세우나**를 값으로 지킨다(web/lib/task-pane.ts) + 배선 소스대조.
//
//  약속(원준 2026-09-20): «보는 세션이 속한 프로젝트의 태스크를, 고를 것 없이 자동으로». 그리기는 DOM 이라 여기서 못 재지만
//  판정은 전부 순수 함수로 뺐다 — 어느 태스크가 «이 세션의 것»인가 · 세 묶음 · 접힌 본문 줄에 비칠 한 줄 · 이미 배치를
//  저장한 사람에게 탭을 **한 번만** 들이기. 규칙이 맞아도 **안 부르면** 화면은 그대로라 배선(W)도 함께 본다.
//
//  엣지 표(사양 spec.md A·C — 행마다 단언 1개 이상. 단언은 전부 값 비교다: truthy 검사는 아무 값이나 통과해 늘 초록불이 된다):
//   E1 자동 머리말(> ⚙ …) 건너뜀 · E2 제목 뒤에 글이 있으면 글 · E3 제목뿐이면 제목 · E4 주석 제거 · E5 표식 제거 · E6 빈 값 · E7 구분선
//   T1 id 일치 · T2 다른 이름(대화 uuid)으로 일치 · T3 이름이 전부 빈 값 · T4 둘 걸리면 안 끝난 것 · T5 둘 다 안 끝났으면 나중 것 · T6 불일치
//   G1 상태→묶음 · G2 내 것은 묶음에서 뺌 · G3 n/m 은 내 것까지 셈
//   D1 고른 값 '1' · D2 고른 값 '0' · D3 안 골랐고 5개(경계) · D4 안 골랐고 6개(경계)
//   S1 자료 뒤에 넣음(last·p 전부) · S2 이미 있으면 그대로(tasks#2·아래 칸 포함) · S3 자료 없으면 맨 앞 · S4 들인 뒤엔 닫아도 안 되살림
//   S5 빈 저장소·객체 아님도 표식 · S6 다른 표식 보존 · S7 켜 둔 탭(act)은 안 건드림
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const root = path.resolve(import.meta.dirname, "..");
const out = mkdtempSync(path.join(tmpdir(), "task-pane-"));
execFileSync(
  path.join(root, "node_modules/.bin/tsc"),
  [path.join(root, "web/lib/task-pane.ts"), "--outDir", out,
   "--module", "esnext", "--target", "es2022", "--skipLibCheck"],
  { stdio: "inherit" },
);
const { bodyExcerpt, taskOfSession, groupTasks, doneOpenByDefault, seedTasksTab,
  stripLeadNotice, sessionTaskOrder, sessionNumbers, sessionColor, externalTasks, moveInOrder, hashQuery, hashMatches } = await import(path.join(out, "task-pane.js"));

let pass = 0;
const eq = (got, want, name) => { assert.deepEqual(got, want, name); pass++; console.log(`ok  ${name}`); };
const read = (p) => readFileSync(path.join(root, p), "utf8");

// ── 접힌 [본문] 줄에 비칠 한 줄 ────────────────────────────────────────────────────────────
{
  const AUTO = "> ⚙ 세션의 첫 지시에서 **자동 생성**된 프로젝트입니다 — 제목·본문·분류는 작업이 구체화되면 보강됩니다.\n\n## 첫 지시(원문)\n\nUI 수정\n\n지금 플로우 상…";
  eq(bodyExcerpt(AUTO), "UI 수정", "E1·E2 자동 머리말과 제목을 건너뛰고 첫 글 줄을 고른다(머리말이 비치면 모든 프로젝트가 같은 줄이다)");
  eq(bodyExcerpt("## 진행 (2026-09-09)\n\n"), "진행 (2026-09-09)", "E3 글이 없고 제목뿐이면 제목을 쓴다(# 표식은 뗀다)");
  eq(bodyExcerpt("<!-- lively:auto-created\n-from-first-prompt -->\n본문이다"), "본문이다", "E4 여러 줄 주석은 통째로 걷는다");
  eq(bodyExcerpt("- **결정**: `안 가`로 간다 ([캔버스](https://x.y/z))"), "결정: 안 가로 간다 (캔버스)", "E5 목록기호·굵게·코드·링크 표식을 뗀다");
  eq([bodyExcerpt(""), bodyExcerpt(null), bodyExcerpt(undefined), bodyExcerpt("\n\n> 인용뿐\n")], ["", "", "", ""], "E6 빈 값·인용뿐이면 빈 문자열");
  eq(bodyExcerpt("---\n\n***\n글"), "글", "E7 구분선은 글이 아니다");
}

// ── 이 세션이 맡은 태스크 ────────────────────────────────────────────────────────────────
{
  const T = (id, cat, sess) => ({ id, status_category: cat, sessions: sess.map((s) => ({ id: s })) });
  const tasks = [T(1, "done", ["box-a"]), T(2, "started", ["box-b"]), T(3, "started", ["box-c", "uuid-c"])];
  eq(taskOfSession(tasks, ["box-b"])?.id, 2, "T1 세션 id 가 맞는 태스크");
  eq(taskOfSession(tasks, ["box-zz", null, "uuid-c", undefined])?.id, 3, "T2 세션의 다른 이름(대화 uuid)으로도 찾는다 — 빈 값은 무시");
  eq(taskOfSession([...tasks, T(8, "started", [""])], [null, undefined, ""]), null, "T3 세션 이름이 전부 빈 값이면 null — 빈 문자열끼리 맞았다고 하지 않는다");
  eq(taskOfSession([T(9, "done", ["s"]), T(4, "started", ["s"])], ["s"])?.id, 4, "T4 둘이 걸리면 안 끝난 것(복원으로 이어받은 세션 — id 가 작아도)");
  eq(taskOfSession([T(4, "started", ["s"]), T(7, "unstarted", ["s"])], ["s"])?.id, 7, "T5 둘 다 안 끝났으면 나중 것(id 큰 쪽)");
  eq(taskOfSession(tasks, ["box-none"]), null, "T6 아무 태스크도 안 맡았으면 null");
}

// ── 세 묶음 ───────────────────────────────────────────────────────────────────────────
{
  const tasks = [{ id: 1, status_category: "done" }, { id: 2, status_category: "started" }, { id: 3, status_category: "unstarted" },
    { id: 4, status_category: null }, { id: 5, status_category: "started" }, { id: 6, status_category: "done" }];
  const g = groupTasks(tasks, null);
  eq([g.doing.map((t) => t.id), g.todo.map((t) => t.id), g.done.map((t) => t.id)], [[2, 5], [3, 4], [1, 6]],
    "G1 started=진행 중 · done=완료 · 그 밖(unstarted·null)=할 일");
  const g2 = groupTasks(tasks, tasks[1]);
  eq([g2.mine?.id, g2.doing.map((t) => t.id)], [2, [5]], "G2 이 세션의 태스크는 카드에 서므로 묶음에서 뺀다(같은 줄이 두 번 서지 않게)");
  const g3 = groupTasks(tasks, tasks[0]);   // 내 것이 «끝난» 태스크
  eq([g3.doneCount, g3.total, g3.done.map((t) => t.id)], [2, 6, [6]], "G3 n/m 끝냄은 카드의 것까지 전부 센다(묶음에서 빠져도)");
}

// ── 완료 묶음을 펴 둘까 ──────────────────────────────────────────────────────────────────
{
  eq(doneOpenByDefault(100, "1"), true, "D1 사람이 펴 두었으면 100개여도 편다");
  eq(doneOpenByDefault(1, "0"), false, "D2 사람이 접었으면 1개여도 접는다");
  eq([doneOpenByDefault(0, ""), doneOpenByDefault(5, null), doneOpenByDefault(5, undefined)], [true, true, true], "D3 안 골랐고 5개(경계)까지는 편다");
  eq(doneOpenByDefault(6, ""), false, "D4 안 골랐고 6개(경계)부터는 접는다 — 펴 두면 진행 중인 줄이 화면 밖으로 밀린다");
}

// ── 저장된 배치에 탭을 한 번만 들이기 ─────────────────────────────────────────────────────────
{
  const lay = (side, extra = {}) => ({ main: ["sessions"], side, bottom: ["timeline"], act: { main: "sessions", side: side[0] || null, bottom: "timeline" }, ...extra });
  const st = { last: lay(["files", "knowledge", "apps"]), p: { 10: lay(["files", "web"]), 11: lay(["knowledge"]) } };
  const r = seedTasksTab(st);
  eq([r.changed, r.added, r.store.last.side, r.store.p[10].side], [true, 3, ["files", "tasks", "knowledge", "apps"], ["files", "tasks", "web"]],
    "S1 자료 바로 뒤에 넣는다 — 마지막 배치(last)와 프로젝트별(p) 전부");
  eq(r.store.p[11].side, ["tasks", "knowledge"], "S3 자료가 없는 곁칸엔 맨 앞에 넣는다");
  eq(r.store.last.act.side, "files", "S7 켜 둔 탭(act)은 안 건드린다 — 보던 화면을 바꾸지 않는다");

  const has = { last: lay(["files", "tasks#2"]), p: { 1: lay(["files"], { bottom: ["timeline", "tasks"] }) } };
  const r2 = seedTasksTab(has);
  eq([r2.added, r2.store.last.side, r2.store.p[1].side], [0, ["files", "tasks#2"], ["files"]],
    "S2 이미 어느 칸에든 있으면(둘째 인스턴스 tasks#2 · 아래 칸 포함) 또 넣지 않는다");

  // S4 — 들인 뒤 사람이 닫았다. 다시 열어도 되살아나면 안 된다.
  r.store.last.side = ["files", "knowledge", "apps"];
  const r3 = seedTasksTab(r.store);
  eq([r3.changed, r3.added, r3.store.last.side], [false, 0, ["files", "knowledge", "apps"]], "S4 한 번 들인 뒤엔 사람이 닫은 탭을 되살리지 않는다");

  const r4 = seedTasksTab({});
  eq([r4.changed, r4.added, r4.store.seeded], [true, 0, { tasks: 1 }],
    "S5 배치가 없는 브라우저도 표식은 찍는다 — 기본 배치로 이미 받았고, 나중에 닫으면 닫힌 채여야 한다");
  eq([seedTasksTab(null).changed, seedTasksTab("x").store.seeded], [true, { tasks: 1 }], "S5b 저장소가 객체가 아니어도 죽지 않는다");
  eq(seedTasksTab({ seeded: { other: 1 } }).store.seeded, { other: 1, tasks: 1 }, "S6 다른 표식을 지우지 않는다");
}

// ── 배선 — 규칙이 맞아도 안 부르면 화면은 그대로다 ──────────────────────────────────────────────
{
  const panes = read("web/v2/panes.ts");
  const at = (needle) => panes.indexOf(needle);
  eq(at("  seedLayoutStore();") > 0 && at("  seedLayoutStore();") < at("  let lay = loadLayout(id);"), true,
    "W1 배치를 읽기 **전에** 들인다 — 뒤에 부르면 첫 화면은 탭 없이 뜨고 다음에야 보인다");
  eq(/side: \['files', 'tasks', 'knowledge', 'apps'\]/.test(panes), true, "W2 기본 배치의 곁칸에 tasks 가 선다(자료 · 태스크 · 지식 · 앱)");
  eq(/JSON\.stringify\(\{ \.\.\.st, last: lay, p: map \}\)/.test(panes), true,
    "W3 배치를 저장할 때 표식(seeded)을 지우지 않는다 — 지우면 다음에 열 때 닫은 탭이 되살아난다");
  const parts = read("web/v2/panes-parts.ts");
  eq(/\{ type: 'tasks', name: '프로젝트', icon: 'projtask'/.test(parts), true, "W4 종류 이름은 'tasks' 그대로(저장된 배치가 이 이름으로 기억한다) · 표시 이름은 프로젝트(#4135) · 그림은 폴더 안의 태스크");
  eq(/import \{ tasksPart \} from '\.\/panes-tasks\.js';/.test(parts) && !/function tasksPart\(/.test(parts), true, "W5 부품은 한 벌 — 옛 tasksPart 가 남아 있지 않다");
  const tk = read("web/v2/panes-tasks.ts");
  eq(/description: text \|\| null, description_base: bodyBase/.test(tk), true, "W6 곁칸 본문 저장은 고치기 시작한 글을 함께 보낸다(세션의 덧붙임을 지우지 않게)");
  eq(/if \(\(typingIn\(list\) \|\| typingIn\(top\)\) && !top\.querySelector\('\.pj-slot-q:focus'\)\) \{ listDirty = true; return; \}/.test(tk), true, "W7 글칸에 손이 가 있는 동안은 목록을 다시 그리지 않는다(8초 틱이 쓰던 글을 날리지 않게) — 빈 칸 찾기만 예외(쳐야 후보가 바뀐다)");
  eq(/description: md \|\| null, description_base: descBase/.test(read("web/v2/proj-settings.ts")), true, "W8 프로젝트 설정의 본문 저장도 같은 가드를 탄다");
  // B11·B12 — 합치기·충돌의 **행위**는 실 SQL 로 잰다(src/v6/project-body-guard.pg-test.mjs). 여기선 REST 로 나가는 모양만 본다:
  //  화면은 상태코드로 가른다(409 = 덮지 않고 사람에게 묻는다). 500 으로 새면 «저장하지 못했어요» 만 뜨고 1.2초마다 되풀이한다.
  const cap = read("src/capabilities/projects-v6.ts");
  eq(/if \(e instanceof ProjectBodyConflictError\)\s*\n\s*throw new HttpError\(409, [^\n]*\{ body: \{ conflict: "description" \} \}\)/.test(cap), true,
    "W9(B11) 본문 충돌은 409 + conflict:\"description\" 로 나간다");
  eq(/if \(patch\.description_base !== undefined && patch\.description === undefined\)\s*\n\s*throw new HttpError\(400,/.test(cap), true,
    "W10(B12) 기준 글만 보내면(교체할 글 없이) 400 — 무엇을 합칠지 알 수 없다");
  eq(/if \("description_base" in b\) patch\.description_base = /.test(cap), true, "W11 REST 파서가 description_base 를 실어 보낸다(빠지면 가드가 조용히 꺼진다)");
  // 격리 리뷰(2026-09-20) — 저장이 가는 도중에 글칸을 걷으면 그 저장의 실패(충돌)가 갈 곳이 없어 글이 사라졌다.
  //  상태기계의 행위는 scripts/autosave.test.mjs 가 잰다. 여기선 **부르는 쪽이 그 결과를 실제로 쓰는지**만 본다.
  eq(/await bodySaver\.flush\(\);[\s\S]{0,160}if \(bodySaver\.dirty\(\)\) \{[^\n]*return false; \}/.test(tk), true,
    "W12 본문 고치기는 flush 뒤에도 못 남긴 글이 있으면 읽기로 돌아가지 않는다(돌아가면 그 글은 글칸과 함께 사라진다)");
  eq((tk.match(/if \(rowSaver\?\.dirty\(\)\) return;/g) || []).length >= 2, true, "W13 태스크 본문도 같다 — 못 저장한 글이 있으면 줄을 접거나 읽기로 돌아가지 않는다");
  eq(/if \(bodyEdit && bodySaver\?\.dirty\(\)\) \{[\s\S]{0,200}keepUnsaved\(ctx\.id, 'body', ta\.value\)/.test(tk), true,
    "W14 칸이 걷힐 때(탭 닫기·화면 떠남) 못 남긴 본문은 글칸 밖에 둔다");
  const ps2 = read("web/v2/proj-settings.ts");
  eq([/const descCore = autoSaveCore\(/.test(ps2), /descInflight|descSaving/.test(ps2), /if \(!desc\.isConnected\) \{[\s\S]{0,420}keepUnsaved\(id, 'body', live\)/.test(ps2)], [true, false, true],
    "W15 프로젝트 설정은 **공용 상태기계**를 쓴다(손으로 짠 둘째 벌이 남아 있지 않다) · 창이 닫힌 뒤의 실패는 live 글을 글칸 밖에 남긴다");
  eq([/const kept = keepUnsaved\(ctx\.id, 'body', live\);/.test(tk), /keepUnsaved\([^)]*\b(text|sent|md)\)/.test(tk + ps2)], [true, false],
    "W17 남기는 글은 늘 live 다 — 보낸 글(text·sent·md)을 보관소에 넣는 자리가 없다(저장 도중 친 글이 빠진다)");
  eq(/if \(stashedByMe\) \{ clearUnsaved\(ctx\.id, 'body'\)/.test(tk) && !/onSaved: \(\) => \{? ?clearUnsaved\(/.test(tk), true,
    "W18 성공한 저장은 **이 편집이 남긴 글**만 지운다 — 지난번에 못 남긴 글(사람이 아직 안 꺼낸 것)을 말없이 지우지 않는다");
  eq(/replaceKids\(acts,\s*\n\s*linkBtn\('내 글 복사', \(\) => void copyText\(lost\)/.test(tk) && !/되살리기/.test(tk), true,
    "W19 보관된 **본문**은 제자리에 되살리지 않고 복사만 한다 — 그때의 본문 전체라, 그 뒤 세션이 덧붙인 기록을 지운다");
  const owners = ["web/v2/panes-tasks.ts", "web/v2/proj-settings.ts", "web/v2/unsaved-store.ts"].filter((f) => read(f).includes("'lively_v2_unsaved_text'"));
  eq([owners, /deviceStore\('lively_v2_unsaved_text'\)/.test(read("web/v2/unsaved-store.ts"))], [["web/v2/unsaved-store.ts"], true],
    "W16 못 남긴 글의 저장소 열쇠는 한 파일에서만, 워크스페이스로 갈리는 deviceStore 로 선언한다(글의 내용이 들어 있다)");
}

// ── 곁칸 «프로젝트» 앱(#4135) — 본문 읽기 · 이 세션의 태스크 순서 · 세션 배지 · 외부 태스크 · 글칸 `#` ─────────────
//  엣지: P1 자동 안내 인용 건너뜀 · P2 안내 없으면 그대로 · P3 인용뿐이면 빈 글 · O1 순서대로 · O2 다른 이름(uuid)으로도 · O3 옛 서버(order 없음)는 한 개로
//   N1 만든 순서로 번호 · N2 옛 id·기록 id 도 같은 번호 · N3 모르는 시각은 뒤로 · C1 같은 번호 같은 색 · X1 돌고 있는 세션 먼저 → 진행 중 → 할 일, 완료 따로
//   M1 옮기기 · M2 범위 밖 · H1 `#` 토큰 · H2 빈칸 뒤만 · H3 안 끝난 것 먼저·고른 것 제외
{
  eq(stripLeadNotice("> 새 작업 창에서 **사람이 이름을 지어** 만든 프로젝트입니다\n\n## 첫 지시(원문)\n\n본문"), "## 첫 지시(원문)\n\n본문",
    "P1 읽기 모드는 맨 앞의 자동 안내 인용을 건너뛴다(원준 «본문부터 보이게»)");
  eq(stripLeadNotice("## 제목\n> 중간 인용은 둔다"), "## 제목\n> 중간 인용은 둔다", "P2 맨 앞이 아니면 인용도 본문이다");
  eq([stripLeadNotice("> 인용뿐\n>\n"), stripLeadNotice(null)], ["", ""], "P3 인용뿐 · 빈 값 → 빈 글");

  const T = [
    { id: 1, name: "가", status_category: "started", sessions: [{ id: "box-a", order: 2, count: 2, current: false }] },
    { id: 2, name: "나", status_category: "unstarted", sessions: [{ id: "box-a", order: 1, count: 2, current: true }, { id: "box-b", order: 1, count: 1, current: true }] },
    { id: 3, name: "다", status_category: "done", sessions: [] },
  ];
  eq(sessionTaskOrder(T, ["box-a"]).map((t) => t.id), [2, 1], "O1 이 세션의 태스크는 서버가 준 순서(order)대로");
  eq(sessionTaskOrder(T, ["uuid-x", null, "box-b"]).map((t) => t.id), [2], "O2 세션 이름 여럿 중 하나라도 맞으면");
  const OLD = [{ id: 7, status_category: "started", sessions: [{ id: "s" }] }, { id: 8, status_category: "done", sessions: [{ id: "s" }] }];
  eq(sessionTaskOrder(OLD, ["s"]).map((t) => t.id), [7], "O3 옛 서버(order 없음)는 taskOfSession 한 개로 물러난다 — 곁칸이 먼저 배포돼도 비지 않는다");
  eq(sessionTaskOrder(T, []), [], "O4 세션이 없으면(새 세션 자리) 빈 목록");

  const N = sessionNumbers([{ id: "c", createdAt: 300 }, { id: "a", createdAt: 100, altIds: ["old-a"], logId: "uuid-a" }, { id: "z" }, { id: "b", createdAt: 200 }]);
  eq([N.get("a"), N.get("b"), N.get("c"), N.get("z")], [1, 2, 3, 4], "N1 번호는 만든 순서 — 이른 것이 1 · N3 시각을 모르면 뒤로");
  eq([N.get("old-a"), N.get("uuid-a")], [1, 1], "N2 옛 박스 id·대화 id 로 물어도 같은 번호");
  eq([sessionColor(1) === sessionColor(9), sessionColor(1) !== sessionColor(2), sessionColor(0) === sessionColor(1)], [true, true, true], "C1 같은 번호는 같은 색 · 이웃은 다른 색 · 0 은 1 로");

  const E = [
    { id: 10, status_category: "unstarted" }, { id: 11, status_category: "started" }, { id: 12, status_category: "unstarted" },
    { id: 13, status_category: "done" }, { id: 14, status_category: "started" },
  ];
  const ex = externalTasks(E, new Set([14]), (t) => t.id === 12);
  eq([ex.open.map((t) => t.id), ex.done.map((t) => t.id)], [[12, 11, 10], [13]], "X1 외부 = 이 세션 것 빼고 · 돌고 있는 세션의 것 → 진행 중 → 할 일 · 완료는 따로");

  eq([moveInOrder([1, 2, 3], 2, 0), moveInOrder([1, 2, 3], 0, 1), moveInOrder([1, 2, 3], 0, 9)], [[3, 1, 2], [2, 1, 3], [2, 3, 1]], "M1 옮기기(to = 옮긴 뒤 자리) · 범위를 넘으면 끝");
  eq(moveInOrder([1, 2], 5, 0), [1, 2], "M2 없는 자리에서 옮기면 그대로");

  eq([hashQuery("할 일 #알림", 7), hashQuery("#", 1), hashQuery("a#b", 3), hashQuery("#알림 끝", 6)], [{ start: 4, q: "알림" }, { start: 0, q: "" }, null, null],
    "H1·H2 커서 앞의 `#` 토큰만(줄 처음·빈칸 뒤) — 낱말 가운데 # 이나 이미 빈칸을 친 뒤는 아니다");
  const HT = [{ id: 41, name: "알림 다시 설계", status_category: "done" }, { id: 42, name: "알림 이동", status_category: "unstarted" }, { id: 43, name: "검색", status_category: "unstarted" }];
  eq([hashMatches(HT, "알림", new Set()).map((t) => t.id), hashMatches(HT, "4", new Set([42])).map((t) => t.id), hashMatches(HT, "", new Set(), 2).length],
    [[42, 41], [43, 41], 2], "H3 이름·번호로 찾기 · 안 끝난 것 먼저 · 고른 것 제외 · 상한");
}

// ── #4135 배선 — 담기 → 글칸 배지 → 세션 열기(taskIds) · 이 세션 입력칸에 넣기 · 순서 PUT ──────────────────────
{
  const parts = read("web/v2/panes-parts.ts");
  const tk = read("web/v2/panes-tasks.ts");
  const ct = read("web/v2/compose-tasks.ts");
  const qs = read("web/v2/quick-session.ts");
  eq(/tasksPick\?\.wire\(ta\);/.test(parts) && /\.\.\.\(taskIds\.length \? \{ taskIds \} : \{\}\)/.test(parts) && /if \(\(!text && !taskIds\.length\) \|\| sending\) return;/.test(parts), true,
    "K1 새 세션 글칸: 배지를 달고 · 담은 게 있으면 지시 없이도 보내고 · taskIds 로 연다");
  eq(/\.\.\.\(taskIds\.length \? \{ taskIds \} : taskId > 0 \? \{ taskId \} : \{\}\)/.test(qs), true, "K2 세션 생성 요청이 taskIds 를 싣는다");
  eq(/root: \(\) => ctx\.paneRoot\(\)/.test(parts) && /const picksRoot = \(\): HTMLElement => ctx\.paneRoot\(\);/.test(tk), true,
    "K3 담은 목록의 울타리는 곁칸 한 벌의 뿌리 — 다른 세션 탭의 글칸으로 새지 않는다");
  eq(/sessions\/\$\{encodeURIComponent\(sid\)\}\/tasks`, \{ method: 'PUT', body: JSON\.stringify\(\{ taskIds: ids \}\) \}/.test(tk), true, "K4 순서 바꾸기·넣기·빼기는 모두 PUT 한 길(목록을 통째로)");
  eq(/putIntoSession\(myIds\(\), text\)/.test(tk) && /registerSessionInput\(/.test(read("web/session-chat.ts")) && /m\.cmd === 'paste' && typeof m\.text === 'string'\) \{ pasteText\(m\.text\)/.test(read("web/standalone/terminal.ts")), true,
    "K5 [본문 넣기] → 세션 화면의 입력칸(터미널이면 붙여넣기) — 보내지 않는다");
  eq(/else act = o \? actChip\('go', t, \{ s: o\.s \}\) : actChip\('take', t\);/.test(tk), true, "K6 세션이 있으면(멈춤 포함) [세션으로], 없을 때만 [이 세션에 넣기]");
  eq([/pn-tk-st/.test(ct.slice(ct.indexOf("function paint()"), ct.indexOf("function dropIndex"))), /TASK_DRAG_TYPE/.test(tk)], [false, true],
    "K7 글칸 배지엔 상태 아이콘이 없다(원준 2026-09-27) · 곁칸 줄을 끌어 글칸 배지 줄에 놓을 수 있다");
  eq([/root\.append\(head, top, list, addBox\);/.test(tk), /replaceKids\(top, \.\.\.tops\);/.test(tk), /tops\.push\(sec\);/.test(tk), /tops\.push\(groupHead\('외부 태스크'/.test(tk)], [true, true, true, true],
    "K9 위(머리·본문·이 세션의 태스크·목록 머리)는 서 있고 스크롤은 아래 목록 안에서만(원준 2026-09-27)");
  const css = read("public/styles/49-v2-projpane.css");
  eq([/\.pj-rdopen \{ max-height: [^;]+; overflow: auto;/.test(css), /iconBtn\('ext'/.test(tk), /'띄워 읽기'/.test(tk), /\.pj-body \{[^}]*background: var\(--bg-tint\)/.test(css)], [true, false, true, false],
    "K10 편 본문은 제 안에서 스크롤(접기 단추가 머리에 남는다) · 본문 머리에 프로젝트 창 단추 없음 · 창 띄우기는 글자 단추 · 본문 바탕은 파랑 틴트가 아니다");
  eq(/<link rel="stylesheet" href="\.\/styles\/49-v2-taxonomy\.css">\s*\n<link rel="stylesheet" href="\.\/styles\/49-v2-projpane\.css">/.test(read("public/index.html")), true, "K8 앱 CSS 가 실린다");
}

console.log(`\n${pass} passed`);
