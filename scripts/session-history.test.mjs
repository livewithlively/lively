// #4553 — 「세션 이력」 앱의 화면 순수 규칙(web/session-history.ts). 원준 2026-10-04: «그 A,B,C안을 그거 들어간 다음에
//  위에 상위 가로탭으로 만들어가지고 셋 다 구현해.» 가로탭 셋 — 대화 찾기 · 작업 일지 · 세션 목록.
//  엣지 표(행마다 시험 하나):
//   H1~H12 세션 목록 탭 — 도는 세션과 중앙 기록을 한 줄로 · F1~F3 거르개
//   W1~W4 일지 기간 · G1~G3 일지 묶음 · S1 합계 · HL1~HL5 «한 일» 한 줄 · C1~C2 복사 글
//   N1~N7 맞은 말의 대화록 자리 · K1~K4 낱말 색칠 자리 · T1 탭 값
//  ⚠ 날짜 경계는 현지 시각 자정이다 — 시험도 현지 시각 생성자(new Date(y, m, d, …))로 만든다(CI 의 TZ 와 무관하게).
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const WEB = process.env.SESSION_HISTORY_WEB || path.join(root, "web");
const out = mkdtempSync(path.join(tmpdir(), "session-history-"));
execFileSync(
  path.join(root, "node_modules/.bin/tsc"),
  [path.join(WEB, "session-history.ts"), "--rootDir", WEB, "--outDir", out, "--module", "esnext", "--moduleResolution", "bundler", "--target", "es2022", "--skipLibCheck"],
  { stdio: "inherit" },
);
const M = await import(path.join(out, "session-history.js"));

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL  ${n} — ${why}`); };
const eq = (got, want, n) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  return a === b ? ok(n) : bad(n, `기대 ${b} · 실제 ${a}`);
};

// 기준 «지금» = 2026-09-30(수) 15:20 현지.
const at = (mo, d, h = 0, mi = 0, s = 0, ms = 0, y = 2026) => new Date(y, mo, d, h, mi, s, ms).getTime();
const NOW = at(8, 30, 15, 20);
const iso = (ms) => new Date(ms).toISOString();

// ── 세션 목록 탭 ────────────────────────────────────────────────────────────────────────────
const live = (id, over = {}) => ({ id, label: "세션 " + id, harness: "claude", owned: true, created: Math.floor(at(8, 30, 9) / 1000), lastActive: Math.floor(at(8, 30, 10) / 1000), agentState: "idle", attached: true, lastViewed: Math.floor(at(8, 30, 11) / 1000), ...over });
const log = (sid, over = {}) => ({ node_id: "", session_id: sid, harness: "claude", title: "첫 지시 " + sid, name: "기록 " + sid, first_seen: iso(at(8, 29, 9)), last_seen: iso(at(8, 29, 10)), bytes: 1000, project_id: null, project_name: null, ...over });
const merge = (l, g) => M.mergeHistoryRows(l, g, NOW);
const pick = (rows, keys) => rows.map((r) => Object.fromEntries(keys.map((k) => [k, r[k]])));

{
  const rows = merge([live("box-1", { claudeSessionId: "c1" })], [log("c1", { node_id: "mac", bytes: 4096, first_seen: iso(at(8, 28, 9)), last_seen: iso(at(8, 30, 12)) })]);
  eq(pick(rows, ["key", "boxId", "convId", "node", "bytes", "title", "name"]),
    [{ key: "box-1", boxId: "box-1", convId: "c1", node: "mac", bytes: 4096, title: "첫 지시 c1", name: "세션 box-1" }],
    "H1 도는 세션과 그 대화의 기록은 한 줄 — 열쇠는 박스 id, 크기·첫 지시·node 는 기록에서");
  eq([rows[0].firstMs, rows[0].lastMs], [at(8, 28, 9), at(8, 30, 12)], "H1b 만든 때는 이른 쪽(기록) · 마지막 활동은 늦은 쪽(기록)");
  const keepLive = merge([live("box-1", { claudeSessionId: "c1" })], [log("c1")]);
  eq([keepLive[0].firstMs, keepLive[0].lastMs], [at(8, 29, 9), at(8, 30, 10)], "H1c 박스의 마지막 활동이 더 늦으면 그 값을 지킨다");
}
{
  const rows = merge([], [log("c2")]);
  eq(pick(rows, ["key", "boxId", "convId", "stateKey", "stateLabel", "alive", "name"]),
    [{ key: "c2", boxId: null, convId: "c2", stateKey: "log", stateLabel: "기록만", alive: false, name: "기록 c2" }], "H2 기록만 남은 세션");
}
{
  const rows = merge([live("box-3"), live("box-4", { claudeSessionId: "c4" })], []);
  eq(pick(rows, ["key", "convId", "bytes"]), [{ key: "box-3", convId: null, bytes: 0 }, { key: "box-4", convId: "c4", bytes: 0 }], "H3 기록이 아직 없는 도는 세션도 줄은 선다");
}
eq(merge([live("box-5", { claudeSessionId: "c5", trashedAt: iso(NOW) })], [log("c5")]), [], "H4 휴지통 표식이 박스에만 있어도 그 대화의 기록 줄이 되살아나지 않는다");
eq(merge([live("box-6", { claudeSessionId: "c6" })], [log("c6", { trashed_at: iso(NOW) })]), [], "H5 휴지통 표식이 기록에만 있어도 박스 줄까지 걷는다");
{
  const dead = { restorable: true, attached: false, agentState: "offline" };
  const a = merge([live("box-old", { claudeSessionId: "c7", ...dead, projectId: 77 }), live("box-new", { claudeSessionId: "c7" })], [log("c7")]);
  eq(pick(a, ["key", "projectId"]), [{ key: "box-new", projectId: 77 }], "H6 같은 대화를 두 박스가 — 살아 있는 쪽이 남고 프로젝트를 물려받는다");
  const b = merge([live("box-a", { claudeSessionId: "c8", ...dead, lastActive: 100 }), live("box-b", { claudeSessionId: "c8", ...dead, lastActive: 200 })], []);
  eq(b.map((r) => r.key), ["box-b"], "H6b 둘 다 멈췄으면 최근에 쓴 쪽");
  const c = merge([live("box-new", { claudeSessionId: "c7" }), live("box-old", { claudeSessionId: "c7", ...dead })], []);
  eq(c.map((r) => r.key), ["box-new"], "H6c 들어온 순서와 무관하다");
}
eq(merge([live("box-9", { observed: false })], [])[0].alive, false, "H7 못 본 판의 행(observed=false)은 «돈다» 고 말하지 않는다");
{
  const r = merge([live("box-10", { restorable: true, attached: false })], [])[0];
  eq([r.alive, r.boxId, r.stateKey, r.stateLabel], [false, "box-10", "restorable", "중단됨"], "H8 멈춘 박스 — 돌지 않지만 세션 화면으로 가는 id 는 남는다");
}
eq(merge([live("box-11", { lastActive: Math.floor(at(8, 30, 8) / 1000) })], [log("c12", { last_seen: iso(at(8, 30, 14)) }), log("c13", { last_seen: iso(at(8, 20)) })]).map((r) => r.key),
  ["c12", "box-11", "c13"], "H9 마지막 활동이 늦은 것부터");
{
  const rows = merge([live("box-14", { projectId: 5 }), live("box-15", { projectId: 6 })], [log("c16", { project_id: 5, project_name: "통합검색" })]);
  eq(Object.fromEntries(rows.map((r) => [r.key, r.projectName])), { "box-14": "통합검색", "box-15": null, c16: "통합검색" }, "H10 도는 세션의 프로젝트 이름은 기록 줄이 아는 이름에서 — 모르면 null");
}
eq([merge([], []), merge(null, undefined)], [[], []], "H11 빈 입력");
eq(merge([live("box-17", { created: 1_700_000_000, lastActive: 1_700_000_500_000 })], [])[0].firstMs, 1_700_000_000_000, "H12 초 단위 시각은 ms 로");
eq(merge([live("box-17", { created: 1_700_000_000, lastActive: 1_700_000_500_000 })], [])[0].lastMs, 1_700_000_500_000, "H12b 밀리초는 그대로");
{
  const rows = merge([live("box-live", { claudeSessionId: "cl" }), live("box-dead", { restorable: true, attached: false }), live("box-dead2", { restorable: true, attached: false, claudeSessionId: "cd" })], [log("cl"), log("cd"), log("crec")]);
  eq(M.histFilter(rows, "live").map((r) => r.key), ["box-live"], "F1 실행 중 = 지금 도는 것");
  eq(M.histFilter(rows, "rec").map((r) => r.key).sort(), ["box-dead2", "crec"], "F2 기록만 = 돌지 않고 읽을 기록이 있는 것(기록 없는 멈춘 박스는 빠진다)");
  eq(M.histFilter(rows, "all").length, 4, "F3 전체");
}

// ── 작업 일지 탭 ────────────────────────────────────────────────────────────────────────────
eq(M.weekStart(NOW), at(8, 28), "W1 수요일 → 그 주 월요일 0시");
eq(M.weekStart(at(9, 4, 23, 59)), at(8, 28), "W1b 일요일 → 지난 월요일(주는 월요일에 시작한다)");
eq(M.weekStart(at(8, 28)), at(8, 28), "W1c 월요일 0시 정각은 그 시각 자신(경계값)");
eq(M.weekStart(at(8, 28) - 1), at(8, 21), "W1d 월요일 0시 1ms 전은 한 주 전 월요일");
eq(M.journalRange("week", NOW), { since: at(8, 28), until: at(9, 5), label: "9월 28일 ~ 10월 4일" }, "W2 이번 주 = [월 0시, 다음 월 0시) · 라벨의 끝은 일요일");
eq(M.journalRange("last-week", NOW), { since: at(8, 21), until: at(8, 28), label: "9월 21일 ~ 9월 27일" }, "W3 지난 주");
eq(M.journalRange("d30", NOW), { since: at(8, 1), until: null, label: "9월 1일 ~ 9월 30일" }, "W4 최근 30일 = 오늘을 포함한 30일 · 끝 없음");

const jr = (sid, lastMs, over = {}) => ({ node_id: "", session_id: sid, name: "세션 " + sid, title: "첫 지시 " + sid, harness: "claude", first_seen: iso(lastMs - 3_600_000), last_seen: iso(lastMs), bytes: 10, project_id: null, project_name: null, box_id: null, asks: 0, edits: 0, activities: [], knowledge: [], tasks: [], ...over });
const act = (id, title, over = {}) => ({ id, type: "feature", title, summary: null, at: null, commit: false, knowledge: [], ...over });
{
  const rows = [jr("a", at(8, 29, 9)), jr("b", at(8, 30, 9)), jr("c", at(8, 30, 14)), jr("d", at(8, 25, 23, 59))];
  const g = M.journalGroups(rows, "day", NOW);
  eq(g.map((x) => [x.label, x.rows.map((r) => r.session_id)]), [["오늘 · 9월 30일 (수)", ["c", "b"]], ["어제 · 9월 29일 (화)", ["a"]], ["9월 25일 (금)", ["d"]]], "G1 날짜별 — 늦은 날이 위 · 묶음 안은 늦은 줄이 위 · 오늘/어제 머리글");
}
{
  const rows = [jr("a", at(8, 30, 14)), jr("b", at(8, 29, 9), { project_id: 5, project_name: "통합검색" }), jr("c", at(8, 30, 9), { project_id: 9, project_name: "데모데이" }), jr("d", at(8, 28, 9), { project_id: 9, project_name: "데모데이" })];
  const g = M.journalGroups(rows, "project", NOW);
  eq(g.map((x) => [x.label, x.rows.map((r) => r.session_id)]), [["데모데이", ["c", "d"]], ["통합검색", ["b"]], ["프로젝트 없음", ["a"]]], "G2 프로젝트별 — 최근에 일한 프로젝트가 위 · 「프로젝트 없음」은 가장 최근이어도 맨 아래");
  eq(M.journalGroups([jr("x", NOW, { project_id: 42 })], "project", NOW)[0].label, "#42", "G3 프로젝트 이름을 모르면 번호로");
}
{
  const k1 = { name: "k-one", title: "지식 하나" }, t1 = { id: 7, name: "태스크", status: "done", project_id: 5 };
  const a1 = act(1, "한 일 하나", { commit: true, knowledge: [k1] });
  const rows = [jr("a", NOW, { project_id: 5, activities: [a1], knowledge: [k1], tasks: [t1] }), jr("b", NOW, { project_id: 5, activities: [a1, act(2, "둘")], knowledge: [k1], tasks: [t1] }), jr("c", NOW)];
  eq(M.journalStats(rows), { sessions: 3, projects: 1, activities: 2, knowledge: 1, tasks: 1, commits: 1 }, "S1 같은 기록·지식·태스크가 여러 줄에 있어도 한 번만 센다");
}
eq(M.journalHeadline(jr("a", NOW, { activities: [act(1, "처음 한 일"), act(2, "마무리한 일")] })), { text: "마무리한 일", source: "activity", more: 1 }, "HL1 기록이 여럿이면 가장 늦은 기록의 제목 + 나머지 수");
eq(M.journalHeadline(jr("a", NOW)), { text: "첫 지시 a", source: "prompt", more: 0 }, "HL2 기록이 없으면 첫 지시(시킨 말임을 밝힌다)");
eq(M.journalHeadline(jr("a", NOW, { title: "  " })), { text: "", source: "none", more: 0 }, "HL3 기록도 첫 지시도 없으면 none");
eq(M.journalHeadline(jr("a", NOW, { activities: [act(1, "", { summary: "요약 글" })] })).text, "요약 글", "HL4 제목이 빈 기록은 요약으로");
eq(M.journalHeadline(jr("a", NOW, { activities_before: 3 })), { text: "", source: "earlier", more: 3 }, "HL5 이 기간엔 기록이 없고 앞선 기간에만 있으면 그 수(«기록 없음» 이라고 말하지 않는다)");
eq(M.journalHeadline(jr("a", NOW, { activities_before: 3, activities: [act(1, "이번 기록")] })).source, "activity", "HL5b 이 기간 기록이 있으면 그 기록이 먼저다");
eq(M.journalCopyText([jr("x", at(8, 30, 9), { activities_before: 2 }), jr("y", at(8, 30, 8))], "기간", NOW).split("\n").slice(3),
  ["[프로젝트 없음]", "- 세션 y (기록 없음)", "- 세션 x (이 기간에 적은 기록 없음)"], "C2 복사 글 — 앞선 기간에만 기록이 있는 세션은 그렇다고 적는다");
{
  const k = { name: "omni", title: "통합검색 as-built" };
  const shared = act(3, "같은 기록");
  const rows = [
    //  서버는 줄의 knowledge 에 그 줄 기록들의 산출 지식을 겹치지 않게 모아 준다(session-journal-store) — 그 모양 그대로.
    jr("late", at(8, 30, 14), { project_id: 5, project_name: "통합검색", activities: [act(2, "배포", { knowledge: [k, { name: "runbook", title: null }] }), shared], knowledge: [k, { name: "runbook", title: null }] }),
    jr("early", at(8, 29, 9), { project_id: 5, project_name: "통합검색", activities: [act(1, "색인 추가"), shared] }),
    jr("none", at(8, 30, 9)),
  ];
  eq(M.journalCopyText(rows, "9월 28일 ~ 10월 4일", NOW).split("\n"), [
    "작업 일지 · 9월 28일 ~ 10월 4일",
    "세션 3 · 프로젝트 1 · 한 일 3 · 지식 2 · 태스크 0",
    "", "[통합검색]", "- 색인 추가", "- 같은 기록", "- 배포 (지식: 통합검색 as-built, runbook)",
    "", "[프로젝트 없음]", "- 세션 none (기록 없음)",
  ], "C1 복사 글 — 머리 두 줄 · 프로젝트 묶음 · 묶음 안은 이른 것부터 · 같은 기록은 한 번 · 기록 없는 세션은 그렇다고");
}

// ── 대화 찾기 탭 ────────────────────────────────────────────────────────────────────────────
const TS = (n) => iso(at(8, 30, 10, n));
const turns = [
  { user: { role: "user", text: "검색을 고쳐 줘", ts: TS(0) }, ai: [{ role: "tool", text: "grep", ts: TS(1) }, { role: "assistant", text: "먼저 살펴보겠습니다", ts: TS(1) }, { role: "assistant", text: "색인을 새로 쌓겠습니다", ts: TS(2) }] },
  { user: { role: "user", text: "배포까지 해 줘", ts: TS(5) }, ai: [{ role: "assistant", text: "머지했습니다", ts: TS(6) }, { role: "assistant", text: "배포를 마쳤습니다", ts: TS(6) }] },
];
eq(M.hitAnchor(turns, { role: "user", ts: TS(5) }, ["배포"]), { q: "1", ln: "" }, "N1 사람 말 — 시각이 같은 턴");
eq(M.hitAnchor(turns, { role: "assistant", ts: TS(2) }, ["색인"]), { q: "0", ln: "0-a1-0" }, "N2 AI 말 — 글 블록 번호로(도구 호출은 번호에 들지 않는다)");
eq(M.hitAnchor(turns, { role: "assistant", ts: TS(6) }, ["배포"]), { q: "1", ln: "1-a1-0" }, "N3 같은 시각의 글 블록이 여럿이면 낱말이 든 블록");
eq(M.hitAnchor(turns, { role: "assistant", ts: TS(6) }, ["없는말"]), { q: "1", ln: "1-a0-0" }, "N3b 낱말 든 블록이 없으면 그 시각의 첫 블록");
eq(M.hitAnchor(turns, { role: "assistant", ts: TS(40) }, ["배포"]), { q: "1", ln: "1-a1-0" }, "N4 시각으로 못 찾으면 낱말이 든 첫 자리 — 고른 쪽(AI) 먼저");
eq(M.hitAnchor(turns, { role: "user", ts: TS(40) }, ["배포"]), { q: "1", ln: "" }, "N4b 고른 쪽이 사람이면 사람 말 먼저");
eq(M.hitAnchor(turns, { role: "user", ts: null }, []), null, "N5 시각도 낱말도 없으면 null");
eq(M.hitAnchor(turns, { role: "user", ts: TS(2) }, []), null, "N6 시각이 같아도 말한 쪽이 다르면 그 자리가 아니다");
eq(M.hitAnchor(turns, null, ["색인"]), { q: "0", ln: "0-a1-0" }, "N7 고른 말이 없으면 낱말이 든 첫 자리(사람 말에 없으면 AI 말)");
eq(M.markRanges("Slack 검색, slack 처럼", ["slack"]), [[0, 5], [10, 15]], "K1 대소문자를 가리지 않고 · 나온 곳 전부");
eq(M.markRanges("통합검색엔진", ["통합검색", "검색엔진", "엔진"]), [[0, 6]], "K2 겹치거나 맞닿은 자리는 하나로 합친다");
eq(M.markRanges("가나다 가나다", ["나", "가"]), [[0, 2], [4, 6]], "K3 낱말이 여럿이면 앞에서부터");
eq([M.markRanges("글", []), M.markRanges("", ["가"]), M.markRanges("글", ["", null])], [[], [], []], "K4 빈 낱말·빈 글");
eq(["journal", "list", "find", "", null, undefined, "zzz"].map(M.readHistTab), ["journal", "list", "find", "find", "find", "find", "find"], "T1 탭 값 — 모르는 값은 첫 탭");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
