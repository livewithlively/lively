// 휴지통 네 탭의 잣대(web/lib/trash-tabs.ts) + 배선 — 값으로 지킨다 (#3778, 원준 2026-09-20 "D로 해서 매니지드까지").
//
//  화면이 지켜야 하는 약속:
//   ① 네 종류는 서로 섞이지 않는다 — 자료 탭엔 source 만, 지식 탭엔 knowledge 만, 옛 길 프로젝트엔 project 만.
//   ② 잠긴 줄(locked — 관리자에게 메타만 보이는 것)은 세우지 않는다: 되살릴 수도 지울 수도 없는 줄은 막다른 길이다.
//   ③ 자료는 두 출처(파일 보관 · 감사 스냅샷)를 버린 순서로 섞되, 줄마다 출처를 들고 다닌다(되살리는 문이 다르다).
//   ④ 세션은 있던 프로젝트로 묶고 「프로젝트 없음」은 늘 맨 끝.
//   ⑤ 처음 설 탭은 기억한 탭 → 무언가 든 첫 탭 → 'sess'. 열 때마다 자리가 바뀌지 않는다.
//  배선(W*)은 «그 잣대를 화면이 실제로 쓴다» 와 «서버의 문이 열려 있다» 를 소스로 확인한다.
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
let pass = 0;
const ok = (cond, what) => { assert.ok(cond, what); pass++; };
const eq = (got, want, what) => { assert.deepEqual(got, want, what); pass++; };

const {
  TRASH_TABS, isTrashTab, bucketOf, kindLabel, extLabel, srcItems, knowItems, auditProjItems, levelLabel,
  groupByProject, matchesQuery, pickInitialTab, bundleOpen,
} = await import(join(root, "public/app/lib/trash-tabs.js"));

// ── 탭 (E1~E2) ─────────────────────────────────────────────────────────────
eq(TRASH_TABS.map((t) => t.key), ["sess", "proj", "src", "know"], "E1 탭은 넷, 순서 = AI 세션 · 프로젝트 · 자료 · 지식");
eq(TRASH_TABS.map((t) => t.label), ["AI 세션", "프로젝트", "자료", "지식"], "E1b 사람이 부른 이름 그대로");
ok(isTrashTab("src") && !isTrashTab("all") && !isTrashTab(null) && !isTrashTab("session"), "E2 「전체」 같은 섞인 탭은 없다");

// ── 자료 (E3~E13) ──────────────────────────────────────────────────────────
const D = (entity, key, at, over = {}) => ({ entity, key, label: `${entity}-${key}`, at, actor: "wonjoon-jang", ...over });
const F = (id, at, over = {}) => ({ id, title: `f${id}.docx`, path: `docs/f${id}.docx`, ext: "docx", bytes: 100, project_id: 7, at, by: "a", has_knowledge: false, ...over });
const deleted = [
  D("knowledge", "k-new", "2026-09-20T05:00:00Z", { doc_type: "research" }),
  D("knowledge", "k-old", "2026-09-10T05:00:00Z"),
  D("knowledge", "k-locked", "2026-09-19T05:00:00Z", { locked: true }),
  D("project", "41", "2026-09-18T05:00:00Z", { level: "task" }),
  D("project", "42", "2026-09-19T05:00:00Z", { level: "project" }),
  D("project", "43", "2026-09-17T05:00:00Z", { locked: true }),
  D("category", "9", "2026-09-19T05:00:00Z"),
  D("source", "500", "2026-09-19T12:00:00Z", { kind: "transcript" }),
  D("source", "501", "2026-09-01T12:00:00Z", { kind: "weird_kind", locked: true }),
];
const files = [F(1, "2026-09-20T01:00:00Z"), F(2, "2026-09-18T01:00:00Z", { ext: "", path: "img/로고.PNG", title: "" })];

const src = srcItems(deleted, files);
eq(src.map((x) => x.key), ["f:1", "a:500", "f:2"], "E3 ★자료 = 파일 보관 ∪ 감사 스냅샷, 버린 순서로 섞는다(잠긴 501 은 없다)");
eq(src.map((x) => x.origin), ["file", "audit", "file"], "E4 줄마다 출처를 들고 다닌다 — 되살리는 문이 다르다");
ok(src.every((x) => x.key.startsWith("f:") || x.key.startsWith("a:")) && !src.some((x) => /k-|41|42/.test(x.key)), "E5 자료 탭에 지식·프로젝트가 섞이지 않는다");
eq(src[2].title, "img/로고.PNG", "E6 제목이 빈 파일은 경로를 제목으로(빈 줄을 세우지 않는다)");
eq(src[2].badge, "PNG", "E7 확장자가 비면 경로에서 뽑아 대문자로");
eq(src[1].badge, "전사록", "E8 글로 적어 둔 자료는 확장자 대신 종류를 적는다");
eq(srcItems([D("source", "x", "2026-09-19T00:00:00Z"), D("source", "0", "2026-09-19T00:00:00Z")], [F(0, "2026-09-19T00:00:00Z"), F(NaN, "2026-09-19T00:00:00Z")]), [], "E9 id 가 숫자가 아니거나 0 이면 세우지 않는다 — 되살릴 좌표가 없다");

eq(extLabel(".HWP", ""), "HWP", "E10 앞의 점을 뗀다");
eq(extLabel("", "자료/이름없는파일"), "FILE", "E11 확장자를 못 찾으면 FILE");
eq(extLabel("verylongext", ""), "VERYLO", "E12 길면 6자에서 자른다(칸이 좁다)");
eq([kindLabel("slack"), kindLabel("minutes"), kindLabel("weird_kind"), kindLabel(null)], ["슬랙 대화", "회의록", "자료", "자료"], "E13 모르는 종류는 '자료' — 종류 키를 그대로 내보이지 않는다");

// ── 지식 · 옛 길 프로젝트 (E14~E17) ────────────────────────────────────────
eq(knowItems(deleted).map((d) => d.key), ["k-new", "k-old"], "E14 ★지식 탭 = knowledge 만, 최근 순, 잠긴 줄 제외");
eq(auditProjItems(deleted).map((d) => d.key), ["42", "41"], "E15 ★옛 길 프로젝트 = project 만(태스크 포함), 최근 순, 잠긴 줄 제외");
ok(!knowItems(deleted).some((d) => d.entity !== "knowledge") && !auditProjItems(deleted).some((d) => d.entity !== "project"), "E16 카테고리는 어느 탭에도 안 선다(WIKI 휴지통의 몫)");
eq([levelLabel("task"), levelLabel("subtask"), levelLabel("project"), levelLabel(null)], ["태스크", "하위 태스크", "프로젝트", "프로젝트"], "E17 level 이 없는 옛 스냅샷은 프로젝트로 본다");

// ── 세션 묶음 (E18~E20) ────────────────────────────────────────────────────
const rows = [{ id: "b", pid: null }, { id: "a", pid: 5 }, { id: "c", pid: 9 }, { id: "d", pid: 5 }, { id: "e", pid: 0 }];
const groups = groupByProject(rows, (r) => r.pid, (pid) => "P" + pid);
eq(groups.map((g) => g.id), [5, 9, 0], "E18 ★있던 프로젝트로 묶고, 「프로젝트 없음」은 늘 맨 끝(먼저 나왔어도)");
eq(groups.map((g) => g.rows.map((r) => r.id)), [["a", "d"], ["c"], ["b", "e"]], "E19 묶음 안 순서는 들어온 순서 그대로");
eq(groups.map((g) => g.name), ["P5", "P9", "프로젝트 없음"], "E20 이름은 호출자가 준 것, 없는 쪽은 「프로젝트 없음」");
eq(groupByProject([], (r) => r.pid, String), [], "E20b 빈 목록 → 빈 묶음");

// ── 찾기 (E21~E22) ─────────────────────────────────────────────────────────
ok(matchesQuery("", "아무거나") && matchesQuery("   ", null), "E21 빈 검색어는 전부 통과");
ok(matchesQuery(" 회의 ", "9월 회의록") && matchesQuery("DOCX", "a.docx") && !matchesQuery("없는말", "9월 회의록", null, undefined) && matchesQuery("#37", "이름", "#3778"), "E22 대소문자·앞뒤 공백 무시, 여러 칸 중 하나만 맞아도 통과");

// ── 처음 설 탭 (E23~E26) ───────────────────────────────────────────────────
const C = (sess, proj, s, know) => ({ sess, proj, src: s, know });
eq(pickInitialTab("know", C(3, 1, 0, 0)), "know", "E23 ★기억한 탭이 있으면 그 탭 — 비어 있어도(사람이 고른 자리다)");
eq(pickInitialTab(null, C(0, 0, 2, 5)), "src", "E24 기억이 없으면 무언가 든 **첫** 탭(탭 순서대로)");
eq(pickInitialTab("all", C(0, 4, 0, 0)), "proj", "E25 옛 값·엉뚱한 값은 무시하고 E24 로");
eq(pickInitialTab(undefined, C(0, 0, 0, 0)), "sess", "E26 다 비었으면 AI 세션");

// ── 프로젝트 안 세션 목록을 펼까 (E27~E29) ─────────────────────────────────
eq([bundleOpen(0, undefined), bundleOpen(1, undefined), bundleOpen(5, undefined), bundleOpen(6, undefined)], [false, true, true, false], "E27 기록이 없으면 1~5개일 때만 편다");
eq([bundleOpen(12, true), bundleOpen(3, false)], [true, false], "E28 사람이 편/접은 기록이 있으면 그대로");
eq(bundleOpen(0, true), false, "E29 안에 든 것이 없으면 펴라고 해도 펼 것이 없다");

// ── 날짜 묶음 (E30) ────────────────────────────────────────────────────────
const NOW = new Date(2026, 8, 20, 12, 0, 0).getTime();
const at = (d, h = 9) => new Date(2026, 8, d, h, 0, 0).toISOString();
eq([bucketOf(at(20, 0), NOW), bucketOf(at(19, 23), NOW), bucketOf(at(14), NOW), bucketOf(at(13), NOW), bucketOf("엉터리", NOW)], ["오늘", "어제", "이번 주", "이전", "이전"], "E30 자정 기준 — 오늘·어제·이번 주(7일)·이전, 못 읽는 시각은 이전");

// ── 배선 (W1~W13) ──────────────────────────────────────────────────────────
const bins = read("web/v2/bins.ts");
ok(/from '\.\.\/lib\/trash-tabs\.js'/.test(bins) && /pickInitialTab\(savedTab\(\), counts\)/.test(bins), "W1 화면이 잣대를 쓴다 — 처음 설 탭");
ok(/srcItems\(extras\.deleted, extras\.files\)/.test(bins) && /knowItems\(extras\.deleted\)/.test(bins) && /auditProjItems\(extras\.deleted\)/.test(bins), "W2 네 탭의 재료를 잣대로 가른다");
ok(/role: 'tablist'/.test(bins) && /TRASH_TABS\.map/.test(bins) && !/chip\('all'/.test(bins), "W3 ★탭은 TRASH_TABS 에서 — 「전체」 칩이 없다");
ok(/\/api\/ui\/deleted\?limit=500&entity=/.test(bins), "W4 ★종류마다 제 목록을 제 상한으로 — 한 목록 200건을 넷이 나눠 쓰지 않는다");
ok(/file-trash\/restore/.test(bins) && /file-trash\/purge/.test(bins) && /\/api\/ui\/deleted\/restore/.test(bins) && /\/api\/ui\/deleted\/purge/.test(bins), "W5 자료의 두 출처가 각자 제 문으로 되살고 지워진다");
ok(/\/api\/ui\/deleted\/snapshot\?entity=knowledge/.test(bins) && /renderMarkdown\(/.test(bins), "W6 지식 읽기 칸이 본문을 받아 그린다");
ok(/extrasFailed \? '목록을 확인하지 못했어요/.test(bins), "W7 못 받았으면 «확인하지 못했어요» — 빈 목록을 «없다» 로 단언하지 않는다");
ok(/if \(p === 'trash'\) return \{ title: '휴지통', noAside: true \}/.test(read("web/v2/main.ts")), "W8 안 D 는 곁칸이 없다");

const trashCap = read("src/capabilities/trash.ts");
ok(/TRASH_ENTITIES = \["knowledge", "project", "category", "source"\]/.test(read("src/v6/trash-store.ts")) && /restoreSource\(before, writeCtx\)/.test(trashCap), "W9 ★자료가 휴지통 목록·복원 대상이다");
ok(/name: "content_purge"[\s\S]*?mcp: false/.test(trashCap) && /name: "content_snapshot"[\s\S]*?mcp: false/.test(trashCap) && /완전 삭제는 사람\(웹\)만/.test(trashCap), "W10 파기·미리보기는 화면 전용 — 에이전트 표면에 세우지 않는다");
const routes = read("src/project/project-routes.ts");
ok(/countActiveLocalUnder\(root, rel\)/.test(routes) && /store\.move\(abs, heldAbs\)/.test(routes) && /stampTrashedLocalPath\(root, rel, stamp\)/.test(routes), "W11 ★파일 삭제 — 자료가 달린 경로는 지우지 않고 옮긴 뒤 도장을 찍는다");
ok(routes.indexOf("store.move(abs, heldAbs)") < routes.indexOf("stampTrashedLocalPath(root, rel, stamp)"), "W11b 도장은 옮긴 **뒤에** — 옮기기가 실패하면 자료는 그대로 살아 있다");
ok(/if \(ctx\?\.source === "mcp"\) throw new HttpError\(403, "프로젝트 완전 삭제는 사람\(웹\)만/.test(read("src/capabilities/projects-v6.ts")), "W12 프로젝트 완전 삭제는 사람만 — 지식·자료 삭제와 같은 잠금");
const sa = read("web/session-actions.ts");
ok(!/kept: \['작업 폴더의 파일·커밋은 그대로 남아요\.'\]/.test(sa) && /프로젝트 폴더\(안의 파일 포함\)까지 지워져요/.test(sa), "W13 ★프로젝트를 함께 지울 때 «작업 폴더는 남는다» 고 말하지 않는다 — 서버는 그 폴더를 지운다");

//  ── 화면 실측(맥미니 헤드리스 크롬, 2026-09-20)에서 잡은 둘 ──
const trashFn = bins.slice(bins.indexOf("export function renderTrash("), bins.indexOf("지난 세션 (#/archive)"));
ok(trashFn.length > 1000 && !/\.replaceChildren\(/.test(trashFn) && /replaceKids\(read,/.test(trashFn), "W14 ★휴지통 화면은 replaceKids 로만 갈아 끼운다 — replaceChildren(null) 은 화면에 글자 «null» 을 찍는다(읽기 칸에서 실제로 찍혔다)");
ok(/\.filter\(\(e\) => e\.entity === entity\)/.test(bins), "W15 ★받은 목록을 그 종류로 다시 거른다 — entity 필터를 모르는 옛 서버는 전부를 돌려줘 같은 줄이 세 벌씩 선다(실측: 지식 43 → 129)");

console.log(`trash-tabs: ${pass} passed`);
