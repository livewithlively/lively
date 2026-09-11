// 표식 없는 세션 (#3892) — 사양.
//
//  사건(2026-09-11, 매니지드): 테넌트 이미지 롤 교대의 SIGTERM 이 되살리기 중이던 createSession 을 «판(new-session) 뒤 ·
//  표식(@box_*) 묶음 전» 에서 끊었다. 그 세션(box-sangmin-yoon-d78e541c)은 AI 가 도는데 tmux @box_harness 가 비어,
//  목록이 `agentState:"exited"` + `working:true` 를 냈고 사이드바는 회색 «셸» 점 · 「지금 볼 것」 제외로 그렸다.
//  여기 잠그는 것 넷(배선은 scripts/session-meta-heal-wiring.test.mjs):
//   O    실행 관측은 **해소된 하네스**로 잰다 — 원시 빈 하네스로 재면 사건의 모순 조합이 난다(재현 포함)
//   M·W  표식·창 옵션 목록 한 벌 — createSession 이 인라인으로 두던 목록과 **순서·값이 같다**(무회귀)
//   H·N  되채우기 — DB 행으로 무엇을 다시 박나 · 언제 박나
//   G    쿨다운 — 폴링마다 나가지 않는다
import { strict as assert } from "node:assert";
import test from "node:test";
import { observeAgentRun, isSpinning, r_harnessIsAgent, PHASE_TTL_SEC } from "./phase.js";
import { sessionMetaCmds, sessionWindowCmds, metaHealCmds, needsMetaHeal, makeMetaHealGate, META_HEAL_COOLDOWN_MS, type HealRow } from "./session-meta-heal.js";
import { chunkTmuxCommands, tmuxBatchable, tmuxBatchRefOf, encodeOptJson, decodeOptJson, LIST_FMT, type TmuxCmd } from "./tmux-exec.js";
import { resolveDesired, type TmuxDesired } from "../sessions/session-desired.js";
import type { SessionState } from "../sessions/session-state.js";

const ID = "box-sangmin-yoon-d78e541c";
const NOW = 1_789_117_419;
const SPIN = "⠂ Claude Code";   // 턴 진행 중 — 브라유 스피너(U+2802)
const STAR = "✳ Claude Code";   // 턴 끝 — 정적 별

function dbRow(p: Partial<SessionState> = {}): SessionState {
  return {
    id: ID, owner: "sangmin-yoon", kind: null, label: "3749 진행해", label_source: "rule", harness: "claude",
    dir: "/work/shared/project/2600", root_key: "shared", subpath: "project/2600",
    flags: { "--model": "opus", "--effort": "max" }, auto_approve: false, invites: [],
    project_id: 2600, project_src: "v6", app_id: null, read_only: false, incognito: false,
    write_vis: null, restrict_read: false, created: 1_789_116_300, last_busy: null, last_seen: null,
    claude_session_id: "616c7377-cfb0-4ffb-af48-75ff1fafa8fc", transcript_path: null, exited_at: null, exit_reason: null,
    node_id: null, superseded_by: null, ...p,
  };
}

// ── O · 실행 관측 (S-O) ─────────────────────────────────────────────────────────

test("O1 ★ 사건 재현 — 표식이 빈 세션을 원시 하네스로 재면 «AI 종료 + 셸 작업» 이 함께 참이고, 해소된 하네스로 재면 «작업 중» 이다 (E1)", () => {
  //  사건 행의 tmux 한 줄을 LIST_FMT 순서 그대로 만든다(@box_* 전부 빈 값 · pane 에서 claude 가 돌고 스피너가 돈다).
  const fields = LIST_FMT.split("\t");
  const at = (k: string): number => { const i = fields.indexOf(k); assert.ok(i >= 0, `LIST_FMT 에 ${k} 가 없다`); return i; };
  const line = new Array<string>(fields.length).fill("");
  line[at("#{session_name}")] = ID;
  line[at("#{pane_current_command}")] = "claude";
  line[at("#{pane_title}")] = SPIN;
  const parts = line.join("\t").split("\t");
  const harnessRaw = parts[at("#{@box_harness}")]!;
  const paneCmd = parts[at("#{pane_current_command}")]!;
  const paneTitle = parts[at("#{pane_title}")]!;
  assert.equal(harnessRaw, "", "사건 행은 @box_harness 가 비어 있다");

  //  종전 판정(원시 하네스) — 목록이 낸 모순 조합 그대로다. 이게 참이어야 아래 «고친 판정» 이 무엇을 바꿨는지가 성립한다.
  const before = observeAgentRun({ harness: harnessRaw, paneCmd, paneTitle, stateRaw: "", nowSec: NOW });
  assert.equal(before.offline, true, "원시 빈 하네스 = 셸 취급 → AI 종료(exited)");
  assert.equal(before.shellWorking, true, "그리고 pane 이 셸이 아니라 셸 작업(working)");

  //  고친 판정 — DB 행(하네스 claude)으로 해소한 하네스.
  const tmuxDesired: TmuxDesired = { owner: "", label: null, harness: harnessRaw || "shell", dir: null, autoApprove: false, flags: {}, invites: [], projectId: null, appId: null };
  const d = resolveDesired(dbRow({ harness: "claude" }), tmuxDesired);
  assert.equal(d.harness, "claude", "DB 가 이긴다");
  const after = observeAgentRun({ harness: d.harness, paneCmd, paneTitle, stateRaw: "", nowSec: NOW });
  assert.deepEqual(after, { offline: false, busy: true, reportedFresh: null, shellWorking: false }, "돌고 있는 claude 세션 = 작업 중");
});

test("O2 해소된 에이전트 하네스 — 스피너가 없으면 작업 중이 아니고, 셸 작업으로도 안 잡힌다 (E2)", () => {
  assert.deepEqual(observeAgentRun({ harness: "claude", paneCmd: "claude", paneTitle: STAR, stateRaw: "", nowSec: NOW }),
    { offline: false, busy: false, reportedFresh: null, shellWorking: false });
});

test("O3 AI 가 끝나 pane 이 셸이면 offline — 스피너 글자·신선한 보고가 남아 있어도 작업 중으로 안 친다 (E3)", () => {
  assert.deepEqual(observeAgentRun({ harness: "claude", paneCmd: "zsh", paneTitle: SPIN, stateRaw: `busy ${NOW - 5}`, nowSec: NOW }),
    { offline: true, busy: false, reportedFresh: null, shellWorking: false });
});

test("O4 셸 하네스에서 무언가 실행 중(vim) — offline 이고 셸 작업이다(회수 판정용 활동, #1059) (E4)", () => {
  assert.deepEqual(observeAgentRun({ harness: "shell", paneCmd: "vim", paneTitle: "", stateRaw: "", nowSec: NOW }),
    { offline: true, busy: false, reportedFresh: null, shellWorking: true });
});

test("O5 셸 하네스가 프롬프트에 있다(-bash) — 셸 작업이 아니다 (E5)", () => {
  assert.deepEqual(observeAgentRun({ harness: "shell", paneCmd: "-bash", paneTitle: "", stateRaw: "", nowSec: NOW }),
    { offline: true, busy: false, reportedFresh: null, shellWorking: false });
});

test("O6 하네스 보고 — TTL 이내(경계 포함)면 싣고, 넘었거나 60초 넘게 미래거나 깨졌으면 버린다(#1221) (E6)", () => {
  const run = (stateRaw: string) => observeAgentRun({ harness: "claude", paneCmd: "claude", paneTitle: STAR, stateRaw, nowSec: NOW }).reportedFresh;
  assert.deepEqual(run(`busy ${NOW - 5}`), { phase: "busy", at: NOW - 5 });
  assert.deepEqual(run(`waiting ${NOW - PHASE_TTL_SEC}`), { phase: "waiting", at: NOW - PHASE_TTL_SEC }, "TTL 경계는 아직 신선하다");
  assert.equal(run(`busy ${NOW - PHASE_TTL_SEC - 1}`), null, "TTL 을 넘으면 폴백(스피너·화면)에 맡긴다");
  assert.equal(run(`busy ${NOW + 61}`), null, "시계 스큐로 영원히 신선한 보고를 만들지 않는다");
  assert.equal(run("nonsense"), null);
});

test("O7 해소된 하네스로 재면 «AI 가 돈다» 와 «셸 작업» 은 배타다 — 하네스×pane×제목 전 조합(빈 하네스·빈 pane 포함) (E7·E8·E9)", () => {
  let n = 0;
  for (const harness of ["claude", "codex", "grok", "shell", ""]) {
    for (const paneCmd of ["claude", "node", "zsh", "-bash", "sh", "vim", ""]) {
      for (const paneTitle of [SPIN, STAR, ""]) {
        const o = observeAgentRun({ harness, paneCmd, paneTitle, stateRaw: `busy ${NOW}`, nowSec: NOW });
        const tag = JSON.stringify({ harness, paneCmd, paneTitle });
        if (r_harnessIsAgent(harness)) assert.equal(o.shellWorking, false, `에이전트 하네스는 셸 작업이 아니다 ${tag}`);
        else assert.equal(o.offline, true, `셸·빈 하네스는 늘 AI 없음이다(종전과 같다) ${tag}`);
        if (o.busy) assert.equal(o.offline, false, `작업 중이면 AI 가 돈다 ${tag}`);
        if (o.busy) assert.equal(isSpinning(paneTitle), true, `작업 중은 스피너에서만 온다 ${tag}`);
        if (o.reportedFresh) assert.equal(o.offline, false, `보고는 AI 가 돌 때만 읽는다 ${tag}`);
        if (paneCmd === "" && r_harnessIsAgent(harness)) assert.equal(o.offline, false, `빈 pane 명령은 셸이 아니다 ${tag}`);
        n++;
      }
    }
  }
  assert.equal(n, 5 * 7 * 3, "표 전부를 돌았다");
});

// ── M · 표식 목록 한 벌 (S-M) ───────────────────────────────────────────────────

/** createSession 이 #3892 이전에 인라인으로 만들던 목록(커밋 faa033ac sessions.ts) — 입력이 같으면 순서·값이 같아야 한다. */
function legacyMeta(id: string, v: { owner: string; label: string; harness: string; chatRuntime: boolean; kind: string; target: string; autoApprove: boolean; appliedFlags: Record<string, string>; invites: string[]; appId?: string; projectId?: number; projectSrc?: string | null }): TmuxCmd[] {
  return [
    ["set-option", "-t", id, "@box_owner", v.owner],
    ["set-option", "-t", id, "@box_label", v.label],
    ["set-option", "-t", id, "@box_harness", v.harness],
    ...(v.chatRuntime ? [["set-option", "-t", id, "@box_runtime", "chat"] as TmuxCmd] : []),
    ["set-option", "-t", id, "@box_kind", v.kind],
    ["set-option", "-t", id, "@box_dir", v.target],
    ["set-option", "-t", id, "@box_auto", v.autoApprove ? "1" : "0"],
    ["set-option", "-t", id, "@box_flags", encodeOptJson(v.appliedFlags)],
    ["set-option", "-t", id, "@box_invites", encodeOptJson(v.invites)],
    ...(v.appId ? [["set-option", "-t", id, "@box_app", String(v.appId)] as TmuxCmd] : []),
    ...(v.projectId ? [
      ["set-option", "-t", id, "@box_project", String(v.projectId)] as TmuxCmd,
      ["set-option", "-t", id, "@box_project_src", v.projectSrc === "org" ? "org" : "v6"] as TmuxCmd,
    ] : []),
  ];
}

test("M1 표식 목록은 종전 createSession 인라인 목록과 같다 — 선택 칸 전부 켬 / 전부 끔 / 출처 없음 (E10·E11)", () => {
  const full = { owner: "sangmin-yoon", label: "3749 진행해", harness: "claude", chatRuntime: true, kind: "human", target: "/work/shared/project/2600", autoApprove: true, appliedFlags: { "--model": "opus", "--effort": "max" }, invites: ["wonjoon-jang"], appId: "app-7", projectId: 2600, projectSrc: "org" };
  assert.deepEqual(
    sessionMetaCmds(ID, { owner: full.owner, label: full.label, harness: full.harness, runtimeChat: full.chatRuntime, kind: full.kind, dir: full.target, autoApprove: full.autoApprove, flags: full.appliedFlags, invites: full.invites, appId: full.appId, projectId: full.projectId, projectSrc: full.projectSrc }),
    legacyMeta(ID, full));
  const bare = { owner: "u", label: ID, harness: "shell", chatRuntime: false, kind: "task", target: "/work/u", autoApprove: false, appliedFlags: {}, invites: [] };
  assert.deepEqual(
    sessionMetaCmds(ID, { owner: bare.owner, label: bare.label, harness: bare.harness, runtimeChat: false, kind: bare.kind, dir: bare.target, autoApprove: false, flags: {}, invites: [] }),
    legacyMeta(ID, bare));
  const noSrc = { ...bare, harness: "claude", projectId: 5, projectSrc: null };
  assert.deepEqual(
    sessionMetaCmds(ID, { owner: noSrc.owner, label: noSrc.label, harness: noSrc.harness, kind: noSrc.kind, dir: noSrc.target, autoApprove: false, flags: {}, invites: [], projectId: 5, projectSrc: null }),
    legacyMeta(ID, noSrc));
  //  출처 칸: org 만 org, 나머지(v6·모르는 값·없음)는 전부 v6 — «값이 있으면 org» 로 접으면 v6 행이 org 로 뒤집힌다.
  for (const [projectSrc, want] of [["org", "org"], ["v6", "v6"], ["weird", "v6"], [null, "v6"], [undefined, "v6"]] as const) {
    assert.deepEqual(sessionMetaCmds(ID, { owner: "u", label: "l", harness: "claude", kind: "human", dir: "/d", autoApprove: false, flags: {}, invites: [], projectId: 5, projectSrc }).at(-1),
      ["set-option", "-t", ID, "@box_project_src", want], `출처 ${JSON.stringify(projectSrc)} → ${want}`);
  }
});

test("M2 목록의 모든 명령이 같은 세션을 지목한다 — 묶어 보내도 각 묶음 첫 명령이 라우팅 키를 쥔다(#3668) (E12)", () => {
  const cmds = [
    ...sessionMetaCmds(ID, { owner: "u", label: "l", harness: "claude", runtimeChat: true, kind: "human", dir: "/d", autoApprove: true, flags: { a: "b" }, invites: ["x"], appId: "a", projectId: 1 }),
    ...sessionWindowCmds(ID, { writeVis: "private", restrictRead: true }),
  ];
  for (const c of cmds) {
    assert.equal(tmuxBatchRefOf(c), ID, `${JSON.stringify(c)} 는 ${ID} 를 지목해야 한다`);
    assert.equal(tmuxBatchable(c), true);
  }
  const chunks = chunkTmuxCommands(cmds);
  assert.ok(chunks.length >= 2, "이 목록은 상한을 넘어 둘 이상으로 나뉜다 — 나뉜 뒤에도 성립해야 의미가 있다");
  for (const chunk of chunks) {
    const first = chunk.slice(0, chunk.indexOf(";") === -1 ? chunk.length : chunk.indexOf(";"));
    assert.equal(tmuxBatchRefOf(first), ID, "각 묶음의 첫 명령이 그 세션을 지목한다");
  }
});

test("M3 실행 폴더를 모르면 @box_dir 을 안 박는다 — 빈 값으로 덮지 않는다 (E13)", () => {
  for (const dir of [null, undefined, ""]) {
    const cmds = sessionMetaCmds(ID, { owner: "u", label: "l", harness: "claude", kind: "human", dir, autoApprove: false, flags: {}, invites: [] });
    assert.equal(cmds.some((c) => c[3] === "@box_dir"), false, `dir=${JSON.stringify(dir)}`);
    assert.equal(cmds.some((c) => c[3] === "@box_harness"), true, "나머지 표식은 그대로 박는다");
  }
});

test("W1 창·기록 범위 목록은 종전 createSession 인라인 목록과 같다 (E14)", () => {
  const legacy = (writeVis?: string, restrictRead?: boolean): TmuxCmd[] => [
    ...(writeVis ? [["set-option", "-t", ID, "@box_write_vis", String(writeVis)] as TmuxCmd] : []),
    ...(restrictRead ? [["set-option", "-t", ID, "@box_restrict", "1"] as TmuxCmd] : []),
    ["set-option", "-t", ID, "mouse", "on"],
    ["set-window-option", "-t", ID, "aggressive-resize", "off"],
    ["set-window-option", "-t", ID, "window-size", "latest"],
  ];
  assert.deepEqual(sessionWindowCmds(ID, {}), legacy());
  assert.deepEqual(sessionWindowCmds(ID, { writeVis: null, restrictRead: false }), legacy());
  assert.deepEqual(sessionWindowCmds(ID, { writeVis: "audience", restrictRead: true }), legacy("audience", true));
});

// ── H · DB 행으로 되채우기 (S-H) ────────────────────────────────────────────────

const optsOf = (cmds: TmuxCmd[]): Map<string, string> => new Map(cmds.map((c) => [String(c[3]), String(c[4])]));

test("H1 ★ 사건 세션의 DB 행 → 표식 전부 + 창 옵션 — 값은 행 그대로, 전부 그 세션을 지목 (E15)", () => {
  const cmds = metaHealCmds(ID, dbRow());
  const o = optsOf(cmds);
  assert.equal(o.get("@box_owner"), "sangmin-yoon");
  assert.equal(o.get("@box_label"), "3749 진행해");
  assert.equal(o.get("@box_harness"), "claude", "이게 비어서 사건이 났다");
  assert.equal(o.get("@box_kind"), "human", "kind 가 NULL 인 옛 행은 human 으로 읽는다");
  assert.equal(o.get("@box_dir"), "/work/shared/project/2600");
  assert.equal(o.get("@box_auto"), "0");
  assert.deepEqual(decodeOptJson(o.get("@box_flags")!, {}), { "--model": "opus", "--effort": "max" }, "플래그 왕복 무손실");
  assert.deepEqual(decodeOptJson(o.get("@box_invites")!, null), [], "초대 왕복 무손실");
  assert.equal(o.get("@box_project"), "2600");
  assert.equal(o.get("@box_project_src"), "v6");
  assert.equal(o.get("mouse"), "on", "창 옵션도 생성 때 못 박힌 채다");
  assert.equal(o.get("aggressive-resize"), "off");
  assert.equal(o.get("window-size"), "latest");
  for (const c of cmds) assert.equal(tmuxBatchRefOf(c), ID);
});

test("H2 DB 에 없는 @box_runtime 은 짓지 않는다 — 모르면 배포 기본(종전 규약) (E16)", () => {
  for (const p of [{}, { kind: "app", app_id: "x" }, { harness: "codex" }] as Partial<SessionState>[]) {
    assert.equal(metaHealCmds(ID, dbRow(p)).some((c) => c[3] === "@box_runtime"), false, JSON.stringify(p));
  }
});

test("H3 이름 — 줄·탭은 공백으로 다듬고(목록 파싱이 줄·탭으로 가른다), 80자 상한, 비면 id (E17)", () => {
  assert.equal(optsOf(metaHealCmds(ID, dbRow({ label: " 첫\t줄\n둘째\r " }))).get("@box_label"), "첫 줄 둘째");
  assert.equal(optsOf(metaHealCmds(ID, dbRow({ label: null }))).get("@box_label"), ID);
  assert.equal(optsOf(metaHealCmds(ID, dbRow({ label: " \n " }))).get("@box_label"), ID);
  assert.equal(optsOf(metaHealCmds(ID, dbRow({ label: "가".repeat(120) }))).get("@box_label"), "가".repeat(80), "생성 규칙과 같은 80자");
});

test("H4 종류·앱·프로젝트·기록 범위 — 행에 있는 것만 싣는다 (E18)", () => {
  const o = optsOf(metaHealCmds(ID, dbRow({ kind: "app", app_id: "app-9", project_id: 7, project_src: "org", write_vis: "private", restrict_read: true, auto_approve: true })));
  assert.equal(o.get("@box_kind"), "app");
  assert.equal(o.get("@box_app"), "app-9");
  assert.equal(o.get("@box_project"), "7");
  assert.equal(o.get("@box_project_src"), "org");
  assert.equal(o.get("@box_write_vis"), "private");
  assert.equal(o.get("@box_restrict"), "1");
  assert.equal(o.get("@box_auto"), "1");
  const bare = optsOf(metaHealCmds(ID, dbRow({ kind: "weird", app_id: null, project_id: null, write_vis: null, restrict_read: false, dir: null })));
  assert.equal(bare.get("@box_kind"), "human", "모르는 종류는 human");
  for (const k of ["@box_app", "@box_project", "@box_project_src", "@box_write_vis", "@box_restrict", "@box_dir"]) assert.equal(bare.has(k), false, `${k} 는 행에 없으니 안 박는다`);
  const typed: HealRow = dbRow();   // DB 행을 그대로 넘길 수 있다(부분집합 타입)
  assert.ok(metaHealCmds(ID, typed).length > 0);
});

// ── N · 언제 되채우나 (S-N) ─────────────────────────────────────────────────────

test("N1 ★ DB 행(소유자 있음) + tmux @box_harness 빈 값 → 되채운다 (E19)", () => {
  assert.equal(needsMetaHeal({ harnessRaw: "", row: dbRow(), managed: null }), true);
  assert.equal(needsMetaHeal({ harnessRaw: "  ", row: dbRow(), managed: "" }), true, "공백뿐인 값도 빈 값이다");
  assert.equal(needsMetaHeal({ harnessRaw: "", row: dbRow(), managed: undefined }), true);
});

test("N2 표식이 있으면 안 한다 — 폴링마다 쓰지 않는다 (E20)", () => {
  assert.equal(needsMetaHeal({ harnessRaw: "claude", row: dbRow(), managed: null }), false);
  assert.equal(needsMetaHeal({ harnessRaw: "shell", row: dbRow(), managed: null }), false, "셸 세션의 정상 표식");
});

test("N3 DB 행이 없으면 안 한다 — 정본 없이 짓지 않는다(백필 전 구세션·노드) (E21)", () => {
  assert.equal(needsMetaHeal({ harnessRaw: "", row: undefined, managed: null }), false);
});

test("N4 상시세션이면 안 한다 — 그 표식은 keep-alive 가 소유한다 (E22)", () => {
  assert.equal(needsMetaHeal({ harnessRaw: "", row: dbRow(), managed: "ks-1" }), false);
});

test("N5 행의 소유자가 비었으면 안 한다 — 빈 소유자를 박으면 접근 판정이 틀린다 (E23)", () => {
  assert.equal(needsMetaHeal({ harnessRaw: "", row: dbRow({ owner: "" }), managed: null }), false);
  assert.equal(needsMetaHeal({ harnessRaw: "", row: { owner: null }, managed: null }), false);
});

// ── G · 쿨다운 (S-G) ────────────────────────────────────────────────────────────

test("G1 세션당 한 번 — 쿨다운 안에서는 다시 안 보내고, 정확히 쿨다운이 지나면 다시 보낸다 (E24)", () => {
  const gate = makeMetaHealGate(60_000);
  const t0 = 1_000_000;
  assert.equal(gate(ID, t0), true);
  assert.equal(gate(ID, t0 + 1), false);
  assert.equal(gate(ID, t0 + 59_999), false);
  assert.equal(gate(ID, t0 + 60_000), true, "경계에서 다시 나간다(앞의 것이 실패했을 수 있다)");
  assert.equal(gate(ID, t0 + 60_001), false);
});

test("G2 세션끼리는 서로의 쿨다운에 안 걸린다 (E25)", () => {
  const gate = makeMetaHealGate(60_000);
  assert.equal(gate("box-a-00000001", 0), true);
  assert.equal(gate("box-b-00000002", 1), true);
  assert.equal(gate("box-a-00000001", 2), false);
  assert.equal(gate("box-b-00000002", 3), false);
});

test("G3 기본 쿨다운은 60초다 (E26)", () => {
  assert.equal(META_HEAL_COOLDOWN_MS, 60_000);
  const gate = makeMetaHealGate();
  assert.equal(gate(ID, 0), true);
  assert.equal(gate(ID, META_HEAL_COOLDOWN_MS - 1), false);
  assert.equal(gate(ID, META_HEAL_COOLDOWN_MS), true);
});
