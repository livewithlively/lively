#!/usr/bin/env node
// 기록 범위(#5016) — 사양 엣지 표(행마다 단언 하나) · 실행: node kit/hooks/record-scope.test.mjs (exit 0=통과)
//  사양: «작업 폴더에서만» 인 컴퓨터에서 작업 폴더 밖에서 켠 AI 세션엔 라이블리가 아무것도 하지 않는다(인코그니토와 같다).
//  «어디서나» 면 제외 폴더 안에서 켠 세션만 그렇다. 방식은 조직이 정하고(서버 사본의 scope), 이 컴퓨터는 목록만 바꾼다.
//  작업 폴더 = 라이블리가 띄운 세션 · 라이블리 프로젝트 표식(.lively/project.json) 아래 · 등록한 폴더 아래.
//  설정 정본은 서버(컴퓨터별), 판정은 로컬 사본으로. 사본이 아직 없으면 종전 동작(어디서나).
//  단언은 문구가 아니라 부작용으로 — 사본 파일 · 가짜 게이트웨이 요청 로그 · 출력 JSON 칸 · 표식 파일.
//  네트워크 없음(가짜 send · 127.0.0.1 가짜 게이트웨이) · 실 홈 무접촉(sandboxEnv).
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import * as rs from "./record-scope.mjs";
import { sandboxEnv } from "../testlib/os-sandbox.mjs";

let pass = 0, fail = 0;
const check = (n, cond, why = "") => { if (cond) { pass++; console.log(`ok  ${n}`); } else { fail++; console.error(`FAIL ${n}${why ? " — " + why : ""}`); } };
const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "cli");
const WIN = process.platform === "win32";

// 샌드박스 — 홈(그 아래 .lively)과 작업 폴더들.
function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "rscope-"));
  const home = join(root, "home");
  const lively = join(home, ".lively");
  const tmp = join(root, "tmp");
  mkdirSync(lively, { recursive: true }); mkdirSync(tmp, { recursive: true });
  return { root, home, lively, tmp, mk: (...p) => { const d = join(root, ...p); mkdirSync(d, { recursive: true }); return d; } };
}
const setScope = (lively, scope, roots = [], pending, more = {}) => rs.writeScopeFile(lively, { scope, work_roots: roots, updated_at: "t", synced_at: "t", pending, ...more });
const decide = (sb, dir, env = {}) => rs.decideRecordScope({ env, dir, lively: sb.lively });
// 자식 프로세스 env — 신원 env 를 비우고(sandboxEnv) 홈·tmp 를 샌드박스로. 세션 폴더는 CLAUDE_PROJECT_DIR 로 준다.
//  ⚠ sandboxEnv 는 호스트 효과를 deny 로 둔다 — 그대로면 훅의 네트워크가 통째로 막혀 «범위 밖이라 요청 0» 이 무의미하게
//   통과한다(첫 실행에서 대조군 H8 이 잡았다). sandbox 모드는 루프백 스텁만 허용한다(다른 훅 테스트와 같은 규약).
const childEnv = (sb, dir, extra = {}) => ({ ...process.env, ...sandboxEnv({ home: sb.home, tmp: sb.tmp }), LIVELY_HOST_EFFECTS_TEST_MODE: "sandbox",
  LIVELY_HOME: sb.home, CLAUDE_PROJECT_DIR: dir, LIVELY_SESSION_DIR: "", LIVELY_HARNESS: "", LIVELY_WORK_ROOTS: "", ...extra });

// ══ 판정 표 ═════════════════════════════════════════════════════════════════
{
  const sb = sandbox(); const out = sb.mk("personal", "diary");
  setScope(sb.lively, "work_folders");
  check("R1 라이블리가 띄운 세션은 작업 폴더 밖이어도 켬", decide(sb, out, { LIVELY_SESSION_ID: "box-1" }).inScope);
  check("R1b `lively run` 으로 띄운 세션(LIVELY_RUN=1)도 작업 폴더 밖이어도 켬", decide(sb, out, { LIVELY_RUN: "1" }).inScope);
  check("R1c LIVELY_RUN 이 1 이 아니면 해당하지 않는다(끔)", !decide(sb, out, { LIVELY_RUN: "0" }).inScope && !decide(sb, out, { LIVELY_RUN: "" }).inScope);
}
{
  const sb = sandbox(); const out = sb.mk("anywhere-dir");
  check("R2 설정 사본이 없으면 종전 동작(켬)", decide(sb, out).inScope);
  //  깨진 사본은 «한 번 받은 적이 있다» 는 뜻 — 닫는 쪽(작업 폴더에서만)으로 보고 다음 세션 시작이 서버 값으로 덮는다.
  writeFileSync(join(sb.lively, rs.SETTINGS_FILE), "{ 깨진 json");
  check("R2b-1 사본이 깨졌으면 «작업 폴더에서만» 으로 본다(끔)", !decide(sb, out).inScope);
  writeFileSync(join(sb.lively, rs.SETTINGS_FILE), JSON.stringify({ scope: "everywhere", work_roots: [] }));
  check("R2b-2 모르는 scope 값도 «작업 폴더에서만»(끔)", !decide(sb, out).inScope);
  const proj = sb.mk("anywhere-dir", "p"); mkdirSync(join(proj, ".lively"), { recursive: true }); writeFileSync(join(proj, ".lively", "project.json"), JSON.stringify({ project_id: 7 }));
  check("R2b-3 깨진 사본이어도 라이블리 프로젝트 폴더는 켬", decide(sb, proj).inScope);
}
{
  const sb = sandbox(); const out = sb.mk("x");
  setScope(sb.lively, "anywhere");
  check("R3 «어디서나» 면 켬", decide(sb, out).inScope);
}
{
  const sb = sandbox(); const proj = sb.mk("lively", "projects", "42"); const deep = sb.mk("lively", "projects", "42", "docs", "a");
  mkdirSync(join(proj, ".lively"), { recursive: true }); writeFileSync(join(proj, ".lively", "project.json"), JSON.stringify({ project_id: 42 }));
  setScope(sb.lively, "work_folders");
  check("R4 위 폴더에 라이블리 프로젝트 표식이 있으면 켬", decide(sb, deep).inScope);
  const bare = sb.mk("bare", "x"); mkdirSync(join(sb.root, "bare", ".lively"), { recursive: true }); writeFileSync(join(sb.root, "bare", ".lively", "project.json"), "{}");
  check("R4b project_id 없는 표식은 표식이 아니다(끔 — repo-worktree-core 와 같은 계약)", !decide(sb, bare).inScope);
}
{
  const sb = sandbox(); writeFileSync(join(sb.lively, "project.json"), JSON.stringify({ project_id: 1 }));   // 홈/.lively/project.json — 키트 자리
  const inHome = join(sb.home, "notes"); mkdirSync(inHome, { recursive: true });
  setScope(sb.lively, "work_folders");
  check("R5 홈의 .lively(키트 자리)는 프로젝트 표식으로 안 본다(끔)", !decide(sb, inHome).inScope);
}
{
  const sb = sandbox(); const root = sb.mk("work", "alphacut"); const sub = sb.mk("work", "alphacut", "api", "src");
  setScope(sb.lively, "work_folders", [root]);
  check("R6a 등록 폴더 그 자체는 켬", decide(sb, root).inScope);
  check("R6b 등록 폴더 아래는 켬", decide(sb, sub).inScope);
  setScope(sb.lively, "work_folders", [root + "/"]);
  check("R6c 끝 구분자가 붙은 등록도 같은 폴더(켬)", decide(sb, sub).inScope);
}
{
  const sb = sandbox(); const alpha = sb.mk("a", "alpha"); const sibling = sb.mk("a", "alphacut");
  setScope(sb.lively, "work_folders", [alpha]);
  check("R7 이름 앞부분만 같은 옆 폴더는 끔", !decide(sb, sibling).inScope);
}
{
  const sb = sandbox(); const x = join(sb.home, "x", "deep"); mkdirSync(x, { recursive: true });
  setScope(sb.lively, "work_folders", ["~/x"]);
  check("R8 `~/x` 등록은 그 컴퓨터 홈 아래 x 로 편다(켬)", decide(sb, x).inScope);
}
{
  const sb = sandbox(); const a = sb.mk("legacy"); const b = sb.mk("from-env");
  writeFileSync(join(sb.lively, "work-roots"), `# 헤더\n\n${a}\n`);
  setScope(sb.lively, "work_folders");
  check("R9a ~/.lively/work-roots 파일 줄도 작업 폴더(켬)", decide(sb, a).inScope);
  check("R9b env LIVELY_WORK_ROOTS 도 작업 폴더(켬)", decide(sb, b, { LIVELY_WORK_ROOTS: b }).inScope);
  check("R9c env 가 없으면 그 폴더는 끔", !decide(sb, b).inScope);
}
{
  const sb = sandbox(); const added = sb.mk("added"); const removed = sb.mk("removed");
  setScope(sb.lively, "work_folders", [removed], { add: [added], remove: [removed] });
  check("R10a 아직 못 올린 추가는 판정에 바로 반영(켬)", decide(sb, added).inScope);
  check("R10b 아직 못 올린 삭제는 판정에 바로 반영(끔)", !decide(sb, removed).inScope);
}
if (!WIN) {
  const sb = sandbox(); const realRoot = sb.mk("real", "work"); const link = join(sb.root, "link-work");
  symlinkSync(realRoot, link);
  setScope(sb.lively, "work_folders", [realRoot]);
  check("R11 등록 폴더를 가리키는 심링크로 연 세션도 켬", decide(sb, link).inScope);
}
{
  const sb = sandbox(); const out = sb.mk("elsewhere");
  setScope(sb.lively, "work_folders", [sb.mk("work")]);
  check("R12 아무 데도 안 걸리면 끔", !decide(sb, out).inScope);
  check("R13 세션 폴더를 모르면(빈 값) 끔", !decide(sb, "").inScope);
}
{
  //  상대경로 줄은 판정하는 쪽의 cwd 에 묶여 뜻이 흔들린다 — 버린다(cwd 가 그 이름의 폴더 바로 위여도 안 켜진다).
  const sb = sandbox(); const parent = sb.mk("rel"); const target = sb.mk("rel", "work");
  setScope(sb.lively, "work_folders", ["work", ".", ".."]);
  const prev = process.cwd(); process.chdir(parent);
  try { check("R14 상대경로로 적힌 작업 폴더는 버린다(끔)", !decide(sb, target).inScope); }
  finally { process.chdir(prev); }
}

// ══ «어디서나» 방식 — 제외 목록 ═══════════════════════════════════════════════
{
  const sb = sandbox(); const ex = sb.mk("personal"); const deep = sb.mk("personal", "diary", "2026"); const other = sb.mk("company", "repo");
  const sib = sb.mk("personal-notes");
  setScope(sb.lively, "anywhere", [], null, { exclude_roots: [ex] });
  const d = decide(sb, deep);
  check("X1 제외 폴더 아래는 끔 — 이유 excluded · 품은 제외 폴더", !d.inScope && d.reason === "excluded" && d.root === ex, JSON.stringify(d));
  check("X2 제외 폴더 그 자체도 끔", !decide(sb, ex).inScope);
  check("X3 제외 목록에 없는 폴더는 켬(이유 anywhere)", decide(sb, other).inScope && decide(sb, other).reason === "anywhere");
  check("X4 이름 앞부분만 같은 옆 폴더는 켬", decide(sb, sib).inScope);
  const proj = sb.mk("personal", "lp"); mkdirSync(join(proj, ".lively"), { recursive: true }); writeFileSync(join(proj, ".lively", "project.json"), JSON.stringify({ project_id: 9 }));
  const pd = decide(sb, join(proj));
  check("X5 제외 폴더 안이어도 라이블리 프로젝트 폴더는 켬", pd.inScope && pd.reason === "project", JSON.stringify(pd));
  check("X6 라이블리가 띄운 세션은 제외 폴더 안이어도 켬", decide(sb, deep, { LIVELY_SESSION_ID: "box-1" }).inScope);
  check("X7 «어디서나» 에선 허용 목록을 판정에 안 쓴다(제외 폴더 안의 작업 폴더도 끔)", (() => {
    setScope(sb.lively, "anywhere", [deep], null, { exclude_roots: [ex] }); return !decide(sb, deep).inScope; })());
  check("X8 «작업 폴더에서만» 에선 제외 목록을 판정에 안 쓴다(목록 밖은 끔 · 목록 안은 켬)", (() => {
    setScope(sb.lively, "work_folders", [other], null, { exclude_roots: [other] }); return decide(sb, other).inScope && !decide(sb, deep).inScope; })());
}
{
  const sb = sandbox(); const a = sb.mk("a"); const b = sb.mk("b");
  setScope(sb.lively, "anywhere", [], { exclude_add: [a], exclude_remove: [b] }, { exclude_roots: [b] });
  check("X9 아직 못 올린 제외 추가·제외 빼기는 판정에 바로 반영", !decide(sb, a).inScope && decide(sb, b).inScope);
  const x = join(sb.home, "secret", "in"); mkdirSync(x, { recursive: true });
  setScope(sb.lively, "anywhere", [], null, { exclude_roots: ["~/secret"] });
  check("X10 `~/secret` 제외는 그 컴퓨터 홈 아래 secret 로 편다(끔)", !decide(sb, x).inScope);
}
{
  //  조직 작업 폴더는 설치 때 ~/.lively/work-roots 파일로도 깔린다 — 이 컴퓨터에서 끈 조직 줄은 그 파일에 남아 있어도 안 켠다.
  const sb = sandbox(); const company = join(sb.home, "company"); mkdirSync(company, { recursive: true });
  writeFileSync(join(sb.lively, "work-roots"), "# 헤더\n~/company\n");
  setScope(sb.lively, "work_folders", [], null, { off_roots: ["~/company"], org: { work_roots: ["~/company"], exclude_roots: [] } });
  check("O1 이 컴퓨터에서 끈 조직 줄은 work-roots 파일에 있어도 끔", !decide(sb, company).inScope);
  setScope(sb.lively, "work_folders", [], { add: ["~/company"] }, { off_roots: ["~/company"], org: { work_roots: ["~/company"], exclude_roots: [] } });
  check("O2 끈 조직 줄을 다시 켜는 못 올린 변경은 바로 반영(켬)", decide(sb, company).inScope);
  setScope(sb.lively, "work_folders", [], { remove: ["~/company"] });
  check("O3 못 올린 빼기도 work-roots 파일 줄을 끈다", !decide(sb, company).inScope);
}

// ══ 세션 폴더 우선순위 ═══════════════════════════════════════════════════════
{
  const env = { CLAUDE_PROJECT_DIR: "/c", CURSOR_PROJECT_DIR: "/u" };
  check("S1 어댑터가 실은 LIVELY_SESSION_DIR 가 먼저", rs.sessionDirOf({ env: { ...env, LIVELY_SESSION_DIR: "/s" }, input: { cwd: "/i" }, cwd: "/p" }) === "/s");
  check("S2 클로드는 시작 폴더(CLAUDE_PROJECT_DIR)가 훅 입력 cwd 보다 먼저", rs.sessionDirOf({ env, input: { cwd: "/i" }, cwd: "/p" }) === "/c");
  check("S3 코덱스는 부모 클로드의 CLAUDE_PROJECT_DIR 를 안 본다", rs.sessionDirOf({ env, input: { cwd: "/i" }, cwd: "/p", harness: "codex" }) === "/i");
  check("S4 커서는 입력 cwd 가 없으면 CURSOR_PROJECT_DIR", rs.sessionDirOf({ env, input: {}, cwd: "/p", harness: "cursor" }) === "/u");
  check("S5 아무것도 없으면 프로세스 cwd", rs.sessionDirOf({ env: {}, input: null, cwd: "/p", harness: "codex" }) === "/p");
}

// ══ 설정 사본 · 서버 맞추기(가짜 send) ═══════════════════════════════════════
function fakeServer(state) {
  const calls = [];
  const send = async (url, opts) => {
    calls.push({ url, method: opts.method || "GET", headers: opts.headers, body: opts.body ? JSON.parse(opts.body) : null });
    if (state.down) throw new Error("ECONNREFUSED");
    if (state.status && state.status !== 200) return { ok: false, status: state.status, json: async () => ({}) };
    if ((opts.method || "GET") === "POST") {
      const b = JSON.parse(opts.body);
      const apply = (list, add = [], remove = []) => { let r = [...list]; for (const a of add) if (!r.includes(a)) r.push(a); return r.filter((x) => !remove.includes(x)); };
      //  진짜 서버처럼 scope 는 버린다 — 방식은 조직 값이다.
      state.pref = { scope: state.pref.scope, work_roots: apply(state.pref.work_roots, b.add, b.remove),
        exclude_roots: apply(state.pref.exclude_roots || [], b.exclude_add, b.exclude_remove), updated_at: "srv" };
      return { ok: true, status: 200, json: async () => ({ machine_id: b.machine_id, preference: state.pref }) };
    }
    return { ok: true, status: 200, json: async () => (state.garbage ? { hello: 1 } : { preference: state.pref, kit_version: "kv-9" }) };
  };
  return { send, calls };
}
{
  const sb = sandbox();
  const { send, calls } = fakeServer({ pref: { scope: "work_folders", work_roots: ["/w/a"], updated_at: "srv" } });
  const r = await rs.syncScopeSettings({ lively: sb.lively, gw: "http://gw/", token: "tk", send, machineId: "m-1" });
  const f = rs.readScopeFile(sb.lively);
  check("Y1 받아 온 값을 사본으로 굳힌다", r.ok && f?.scope === "work_folders" && f.work_roots[0] === "/w/a", JSON.stringify(f));
  check("Y2 키트 버전을 돌려준다(범위 밖 자가 업데이트용)", r.kit_version === "kv-9");
  check("Y3 세션 신원 헤더·폴더를 보내지 않는다", calls.length === 1 && !calls[0].headers["x-lively-session"] && !calls[0].headers["x-lively-workspace"]
    && /\/api\/ui\/me\/local-scope\?machine_id=m-1$/.test(calls[0].url), JSON.stringify(calls));
}
{
  const sb = sandbox();
  rs.addPending(sb.lively, { add: ["/w/new"] });
  const { send, calls } = fakeServer({ pref: { scope: "work_folders", work_roots: [], updated_at: "srv" } });
  await rs.syncScopeSettings({ lively: sb.lively, gw: "http://gw", token: "tk", send, machineId: "m-1" });
  const f = rs.readScopeFile(sb.lively);
  check("Y4 못 올린 변경을 먼저 올리고 비운다", calls[0].method === "POST" && calls[0].body.add?.[0] === "/w/new" && !f.pending && f.work_roots.includes("/w/new"), JSON.stringify({ calls, f }));
}
{
  const sb = sandbox(); setScope(sb.lively, "anywhere", ["/keep"]);
  const r = await rs.syncScopeSettings({ lively: sb.lively, gw: "http://gw", token: "tk", send: fakeServer({ status: 404 }).send, machineId: "m-1" });
  check("Y5 구 게이트웨이(404)면 사본을 건드리지 않는다", !r.ok && rs.readScopeFile(sb.lively)?.scope === "anywhere");
  await rs.syncScopeSettings({ lively: sb.lively, gw: "http://gw", token: "tk", send: fakeServer({ garbage: true, pref: {} }).send, machineId: "m-1" });
  check("Y6 모양이 틀린 응답이면 사본을 건드리지 않는다", rs.readScopeFile(sb.lively)?.scope === "anywhere");
}
{
  const sb = sandbox();
  const r1 = await rs.changeScopeSettings({ lively: sb.lively, gw: "http://gw", token: "tk", send: fakeServer({ down: true }).send, machineId: "m-1", add: ["/w/x"] });
  const e1 = rs.effectiveSettings(sb.lively);
  check("Y7 서버에 못 닿으면 쌓아 두고 판정엔 바로 반영", !r1.synced && e1.work_roots.includes("/w/x") && e1.pending?.add?.[0] === "/w/x", JSON.stringify(e1));
  const up = fakeServer({ pref: { scope: "work_folders", work_roots: [], updated_at: "srv" } });
  const r2 = await rs.changeScopeSettings({ lively: sb.lively, gw: "http://gw", token: "tk", send: up.send, machineId: "m-1", exclude_add: ["/w/ex"] });
  const f2 = rs.readScopeFile(sb.lively);
  check("Y8 닿으면 앞서 쌓인 변경까지 한 묶음으로 올려 서버 답을 사본으로 — 대기열이 빈다(허용·제외 목록 함께)",
    r2.synced && f2.work_roots.includes("/w/x") && f2.exclude_roots.includes("/w/ex") && !f2.pending
    && up.calls[0]?.body?.add?.[0] === "/w/x" && up.calls[0]?.body?.exclude_add?.[0] === "/w/ex", JSON.stringify(f2));
}
{
  const sb = sandbox();
  rs.addPending(sb.lively, { add: ["/w/a"] });
  rs.addPending(sb.lively, { remove: ["/w/a"] });
  const p = rs.readScopeFile(sb.lively).pending || {};
  check("Y9 넣었다 뺀 변경은 서로 지운다", !(p.add || []).includes("/w/a") && (p.remove || []).includes("/w/a"), JSON.stringify(p));
}
{
  const sb = sandbox(); const { send, calls } = fakeServer({ pref: { scope: "anywhere", work_roots: [] } });
  await rs.syncScopeSettings({ lively: sb.lively, gw: "http://gw", token: "", send, machineId: "m-1" });
  await rs.syncScopeSettings({ lively: sb.lively, gw: "", token: "tk", send, machineId: "m-1" });
  await rs.syncScopeSettings({ lively: sb.lively, gw: "http://gw", token: "tk", send, machineId: "" });
  check("Y10 토큰·게이트웨이·컴퓨터 id 가 없으면 아무것도 안 보낸다", calls.length === 0 && !rs.readScopeFile(sb.lively));
}
{
  //  같은 키를 오프라인에서 바꾼 뒤 온라인에서 다시 바꾸면 **나중 것**이 이겨야 한다 — 판정(사본)도, 서버도.
  //  방식(scope)은 이 컴퓨터가 못 바꾼다 — 옛 키트가 남긴 pending 의 scope 도 판정에 안 쓰고, 올리면 서버가 버린 값(조직 값)으로 굳는다.
  const sb = sandbox();
  setScope(sb.lively, "work_folders", [], { scope: "anywhere" });
  const out = sb.mk("personal");
  check("Y11a 옛 키트가 남긴 pending 의 «어디서나» 는 판정에 안 쓴다(끔)", rs.effectiveSettings(sb.lively)?.scope === "work_folders" && !decide(sb, out).inScope);
  const st = { pref: { scope: "work_folders", work_roots: [], updated_at: "2026-10-26T00:00:00Z" } };
  const up = fakeServer(st);
  await rs.syncScopeSettings({ lively: sb.lively, gw: "http://gw", token: "tk", send: up.send, machineId: "m-1" });
  check("Y11b 그 pending 은 올리고 걷는다 — 서버(조직) 방식이 남는다",
    up.calls[0]?.body?.scope === "anywhere" && !rs.readScopeFile(sb.lively)?.pending && rs.readScopeFile(sb.lively)?.scope === "work_folders", JSON.stringify(up.calls));
  const st2 = { pref: { scope: "work_folders", work_roots: ["/w/x"], updated_at: "2026-10-26T00:00:00Z" } };
  const sb2 = sandbox();
  rs.recordServerState(sb2.lively, st2.pref);
  await rs.changeScopeSettings({ lively: sb2.lively, gw: "http://gw", token: "tk", send: fakeServer({ down: true }).send, machineId: "m-1", remove: ["/w/x"] });
  await rs.changeScopeSettings({ lively: sb2.lively, gw: "http://gw", token: "tk", send: fakeServer(st2).send, machineId: "m-1", add: ["/w/x"] });
  const e2 = rs.effectiveSettings(sb2.lively);
  check("Y12 오프라인 빼기 뒤 온라인 다시 넣기 — 판정·서버 모두 들어 있다", !!e2?.work_roots?.includes("/w/x") && st2.pref.work_roots.includes("/w/x"), JSON.stringify({ e2, srv: st2.pref }));
}
{
  //  서버와 맞추는 사이(GET 응답 대기)에 다른 프로세스(CLI)가 pending 을 더하면 그 몫이 사라지면 안 된다.
  const sb = sandbox(); rs.recordServerState(sb.lively, { scope: "work_folders", work_roots: [], updated_at: "2026-10-26T00:00:00Z" });
  const send = async (url, opts) => {
    if ((opts.method || "GET") === "GET") rs.addPending(sb.lively, { add: ["/w/late"] });   // 응답이 오기 전에 CLI 가 끼어든다
    return { ok: true, status: 200, json: async () => ({ preference: { scope: "work_folders", work_roots: [], updated_at: "2026-10-26T00:00:01Z" } }) };
  };
  await rs.syncScopeSettings({ lively: sb.lively, gw: "http://gw", token: "tk", send, machineId: "m-1" });
  check("Y13 맞추는 사이 끼어든 변경은 남는다(갱신 소실 없음)", rs.effectiveSettings(sb.lively).work_roots.includes("/w/late"), JSON.stringify(rs.readScopeFile(sb.lively)));
}

{
  const sb = sandbox();
  const pref = { scope: "anywhere", work_roots: ["~/w"], exclude_roots: ["~/p"], off_roots: ["~/w2"], org: { work_roots: ["~/w", "~/w2"], exclude_roots: ["~/p"] }, updated_at: "srv" };
  await rs.syncScopeSettings({ lively: sb.lively, gw: "http://gw", token: "tk", send: fakeServer({ pref }).send, machineId: "m-1" });
  const f = rs.readScopeFile(sb.lively);
  check("Y14 서버가 준 제외 목록·끈 조직 줄·조직 목록을 사본에 굳힌다",
    f?.scope === "anywhere" && f.exclude_roots[0] === "~/p" && f.off_roots[0] === "~/w2" && f.org.work_roots.length === 2 && f.org.exclude_roots[0] === "~/p", JSON.stringify(f));
  const sb2 = sandbox();
  await rs.syncScopeSettings({ lively: sb2.lively, gw: "http://gw", token: "tk", send: fakeServer({ pref: { scope: "work_folders", work_roots: ["/w"], updated_at: "srv" } }).send, machineId: "m-1" });
  const f2 = rs.readScopeFile(sb2.lively);
  check("Y15 옛 게이트웨이 응답(제외 목록 없음)도 받는다 — 빈 목록", f2?.work_roots[0] === "/w" && f2.exclude_roots.length === 0 && f2.off_roots.length === 0, JSON.stringify(f2));
  const sb3 = sandbox(); setScope(sb3.lively, "work_folders", ["/keep"]);
  await rs.syncScopeSettings({ lively: sb3.lively, gw: "http://gw", token: "tk", send: fakeServer({ pref: { scope: "anywhere", work_roots: [], exclude_roots: "nope", updated_at: "srv" } }).send, machineId: "m-1" });
  check("Y16 제외 목록 모양이 틀린 응답이면 사본을 건드리지 않는다", rs.readScopeFile(sb3.lively)?.work_roots[0] === "/keep");
}
{
  const n = rs.outsideNotice({ dir: "/h/personal/diary", reason: "excluded", root: "/h/personal", harness: "claude", win: false, nodeExe: "/usr/bin/node", lively: "/h/.lively" });
  check("N9 제외 폴더 알림 — 사람에게 «제외 폴더» 를 말한다", n.user.includes("제외 폴더") && n.user.includes("/lively-connect"), n.user);
  check("N10 제외 폴더 알림 — AI 에게 품은 제외 폴더를 빼는 명령과 «그 아래 전부» 를 준다",
    n.ai.includes("`lively work-root add '/h/personal'`") && n.ai.includes("그 아래 전부") && n.ai.includes("제외 목록을 바꾸지 마라"), n.ai);
  const o = rs.outsideNotice({ dir: "/h/x", harness: "claude", win: false, nodeExe: "/usr/bin/node", lively: "/h/.lively" });
  check("N11 작업 폴더 밖 알림은 종전 그대로(이유를 안 주면 outside)", o.user.includes("작업 폴더가 아니라") && o.ai.includes("`lively work-root add '/h/x'`"), o.ai);
}

// ══ 알림 · 늦은 주입 표식 ════════════════════════════════════════════════════
//  등록 명령의 꼴은 기본 인자가 이 프로세스의 플랫폼·node 를 따른다(윈도 CI 에선 node 직결형) — 종전 명령을 보는 행은 win: false 로 입력을 고정한다.
check("N1 클로드 알림은 /lively-connect 를 가리킨다", rs.outsideNotice({ dir: "/p", harness: "claude" }).user.includes("/lively-connect"));
check("N2 코덱스 알림은 /prompts:lively-connect", rs.outsideNotice({ dir: "/p", harness: "codex" }).user.includes("/prompts:lively-connect"));
check("N3 그 밖의 하네스는 CLI(lively work-root add)", rs.outsideNotice({ dir: "/p", harness: "grok", win: false }).user.includes("lively work-root add"));
{
  const flags = mkdtempSync(join(tmpdir(), "rscope-flags-"));
  const set = rs.markStartedOutside("abc-1", flags), seen = rs.startedOutside("abc-1", flags);
  rs.clearStartedOutside("abc-1", flags);
  check("N5 늦은 주입 표식 — 세우고·보고·걷는다", set && seen && !rs.startedOutside("abc-1", flags));
  check("N6 세션 id 꼴이 아니면 표식을 안 세운다", !rs.markStartedOutside("../x", flags) && !existsSync(join(flags, "..", "x.scope-out")));
}
{
  const evil = '/tmp/a"; rm -rf ~; echo "`x`';
  const n = rs.outsideNotice({ dir: evil, harness: "claude", win: false });
  check("N7 따옴표·백틱·달러가 든 폴더 이름은 AI 안내·명령에 넣지 않는다", !n.ai.includes(evil) && !n.ai.includes("rm -rf") && n.ai.includes("lively work-root add"));
  const p = rs.outsideNotice({ dir: "/w/p", harness: "claude", plugin: true });
  check("N8 플러그인만 깐 컴퓨터는 웹 화면을 가리킨다(/lively-connect 없음)", !p.user.includes("/lively-connect") && p.user.includes("내 컴퓨터별 연결"));
}
{
  // 윈도 경로는 역슬래시가 구분자다 — 이름을 넣고, 등록 명령은 작은따옴표로 감싸 셸이 글자 그대로 받게 한다.
  const win = "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\my proj";
  const w = rs.outsideNotice({ dir: win, harness: "claude", win: false });
  check("N9 윈도 경로도 AI 안내에 그 폴더를 짚고, 등록 명령은 작은따옴표로 감싼다", w.ai.includes(`\`${win}\``) && w.ai.includes(`lively work-root add '${win}'`), w.ai.slice(0, 300));
  const unc = "\\\\srv\\share\\proj";
  check("N10 UNC 경로도 글자 그대로 넣는다", rs.outsideNotice({ dir: unc, harness: "codex", win: false }).ai.includes(`lively work-root add '${unc}'`));
  const q = "/home/me/it's";
  const nq = rs.outsideNotice({ dir: q, harness: "claude", win: false });
  check("N11 작은따옴표가 든 폴더 이름은 넣지 않는다(명령의 감싸개라서)", !nq.ai.includes(q) && nq.ai.includes("이 폴더에서 `lively work-root add`"));
}
if (process.platform !== "win32") {
  // 안내 속 명령을 실제 셸에 넣으면 인자가 그 폴더 글자 그대로 와야 한다 — 공백·역슬래시·끝 역슬래시(드라이브 루트 꼴)까지.
  const dirs = ["C:\\Users\\RUNNER~1\\my proj", "\\\\srv\\share\\p", "C:\\", "/home/me/a b\\c"];
  const got = dirs.map((d) => {
    const m = rs.outsideNotice({ dir: d, harness: "claude", win: false }).ai.match(/`lively work-root add (.+?)`/);
    if (!m) return null;
    try { return execFileSync("sh", ["-c", `printf %s ${m[1]}`], { encoding: "utf8" }); } catch { return null; }
  });
  check("N12 등록 명령을 셸에 넣으면 인자가 그 폴더 글자 그대로다", got.every((g, i) => g === dirs[i]), JSON.stringify(got));
}
{
  // 배치 실행이 막힌 윈도우 PC(2026-11-05) — node 절대경로를 알면 lively.cmd 대신 node 로 lively.mjs 를 부르는 명령을 준다.
  //  같은 표를 kit/cli/install-scope-notice.test.mjs 가 CLI 쪽 같은 이름 함수와 맞대 본다.
  const NODE = "C:\\Profiles\\me\\.lively\\runtime\\node-v22.11.0-win-x64\\node.exe";
  const CLI_JS = "C:\\Profiles\\me\\.lively\\lib\\lively.mjs";
  const DIRECT = '& "C:/Profiles/me/.lively/runtime/node-v22.11.0-win-x64/node.exe" "C:/Profiles/me/.lively/lib/lively.mjs" work-root add';
  const rows = [
    ["윈도+절대 node.exe · 폴더 없음", { win: true, nodeExe: NODE, cliPath: CLI_JS }, DIRECT],
    ["윈도+절대 node.exe · 공백 든 윈도 폴더", { win: true, nodeExe: NODE, cliPath: CLI_JS, dir: "C:\\work\\my proj" }, `${DIRECT} 'C:\\work\\my proj'`],
    ["윈도+절대 node.exe · 작은따옴표 든 폴더는 빼고", { win: true, nodeExe: NODE, cliPath: CLI_JS, dir: "C:\\work\\it's" }, DIRECT],
    ["윈도+슬래시 드라이브 경로 · 대문자 NODE.EXE", { win: true, nodeExe: "D:/rt/NODE.EXE", cliPath: CLI_JS }, '& "D:/rt/NODE.EXE" "C:/Profiles/me/.lively/lib/lively.mjs" work-root add'],
    ["윈도+UNC node.exe", { win: true, nodeExe: "\\\\srv\\rt\\node.exe", cliPath: CLI_JS }, '& "//srv/rt/node.exe" "C:/Profiles/me/.lively/lib/lively.mjs" work-root add'],
    ["윈도+맨몸 node — 종전 명령", { win: true, nodeExe: "node", cliPath: CLI_JS, dir: "C:\\w\\p" }, "lively work-root add 'C:\\w\\p'"],
    ["윈도+상대경로 node.exe — 종전 명령", { win: true, nodeExe: "rt\\node.exe", cliPath: CLI_JS }, "lively work-root add"],
    ["윈도+절대경로지만 node.exe 아님 — 종전 명령", { win: true, nodeExe: "C:\\rt\\node", cliPath: CLI_JS }, "lively work-root add"],
    ["윈도 아님+윈도 꼴 node.exe — 종전 명령", { win: false, nodeExe: NODE, cliPath: CLI_JS }, "lively work-root add"],
    ["윈도 아님 · 폴더", { win: false, nodeExe: "/usr/bin/node", cliPath: "/home/me/.lively/lib/lively.mjs", dir: "/home/me/a b" }, "lively work-root add '/home/me/a b'"],
    ["윈도 아님 · 작은따옴표 든 폴더는 빼고", { win: false, nodeExe: "/usr/bin/node", cliPath: "/x", dir: "/home/me/it's" }, "lively work-root add"],
  ];
  for (const [name, opts, want] of rows) {
    const got = rs.workRootAddCommand(opts);
    check(`W1 등록 명령 — ${name}`, got === want, got);
  }
  check("W2 MCP 문구 — node 직결이면 PowerShell 아닌 셸의 & 빼기를 함께 말한다",
    rs.workRootAddVia({ win: true, nodeExe: NODE, cliPath: CLI_JS }) === `셸의 \`${DIRECT}\`(PowerShell 이면 그대로, 다른 셸이면 맨 앞 «& » 를 빼고)`);
  check("W2 MCP 문구 — 아니면 종전 그대로", rs.workRootAddVia({ win: false, nodeExe: "/usr/bin/node", cliPath: "/x" }) === "셸의 `lively work-root add`");

  const lively = "C:\\Profiles\\me\\.lively";
  const dir = "C:\\work\\proj";
  const c = rs.outsideNotice({ dir, harness: "claude", win: true, nodeExe: NODE, lively });
  check("W3 ★ 윈도 node 직결 — AI 가 실행할 명령이 node 직접 호출이고 lively.cmd 를 부르지 않는다",
    c.ai.includes(`\`${DIRECT} '${dir}'\``) && !c.ai.includes("`lively work-root add") && c.ai.includes("PowerShell 이면 그대로"), c.ai);
  check("W3 사람 한 줄은 여전히 /lively-connect", c.user.includes("/lively-connect") && !c.user.includes("node.exe"), c.user);
  const g = rs.outsideNotice({ dir, harness: "grok", win: true, nodeExe: NODE, lively });
  check("W4 ★ 커맨드가 없는 하네스 — 사람 한 줄·AI 안내 모두 node 직접 호출", g.user.includes(`\`${DIRECT}\``) && !g.user.includes("`lively work-root add") && !g.ai.includes("`lively work-root add"), g.user);
  const u = rs.outsideNotice({ dir: "C:\\work\\it's", harness: "claude", win: true, nodeExe: NODE, lively });
  check("W5 넣을 수 없는 폴더 이름이면 «이 폴더에서» node 직접 호출", u.ai.includes(`이 폴더에서 \`${DIRECT}\``) && !u.ai.includes("it's"), u.ai);
  const b = rs.outsideNotice({ dir, harness: "claude", win: true, nodeExe: "node", lively });
  check("W6 윈도라도 node 경로를 모르면 종전 명령 · & 안내 없음", b.ai.includes(`\`lively work-root add '${dir}'\``) && !b.ai.includes("PowerShell 이면"), b.ai);
}

// ══ 가짜 게이트웨이(127.0.0.1) — 받은 요청을 센다 ══════════════════════════════
async function withGateway(fn) {
  const hits = [], reqs = [];
  const srv = createServer((req, res) => {
    let body = ""; req.on("data", (c) => { body += c; });
    req.on("end", () => {
      hits.push(req.url);
      reqs.push({ url: req.url, method: req.method, headers: req.headers });
      res.setHeader("content-type", "application/json");
      if (req.url === "/mcp") {
        let id = null; try { id = JSON.parse(body).id; } catch { /* */ }
        res.end(JSON.stringify({ jsonrpc: "2.0", id, result: { tools: [{ name: "probe_tool", inputSchema: { type: "object" } }] } }));
        return;
      }
      res.end(JSON.stringify({ hooks: [], context: "LATE-CTX" }));
    });
  });
  // ⚠ 포트를 직접 고른다 — 테스트용 HostEffects(sandbox)는 루프백 포트 32768 이상만 연다(host-effects.mjs
  //  sandboxNetworkAllowed). listen(0) 은 커널마다 그 아래를 줄 수 있어(gVisor 박스 실측: 16007·24969 …) 그때 훅의 요청이
  //  «denied» 로 조용히 막혀 대조군이 흔들렸다.
  for (let i = 0; ; i++) {
    const port = 40000 + Math.floor(Math.random() * 20000);
    const okListen = await new Promise((r) => { srv.once("error", () => r(false)); srv.listen(port, "127.0.0.1", () => r(true)); });
    if (okListen) break;
    if (i > 50) throw new Error("가짜 게이트웨이 포트를 못 잡았다");
  }
  try { return await fn(`http://127.0.0.1:${srv.address().port}`, hits, reqs); }
  finally { srv.close(); }
}
function runHook(script, args, env, stdin) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [join(HERE, script), ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
    let out = ""; p.stdout.on("data", (c) => { out += c; });
    p.on("close", () => resolve(out));
    p.stdin.end(JSON.stringify(stdin));
  });
}

// ══ 훅 실측: session-preload(토큰 없음 — 네트워크 0) ═══════════════════════════
function runPreload(sb, dir) {
  return execFileSync(process.execPath, [join(HERE, "session-preload.mjs")], {
    input: JSON.stringify({ session_id: "sess-1", cwd: dir, hook_event_name: "SessionStart", source: "startup" }),
    env: childEnv(sb, dir, { LIVELY_HOME: "" }), encoding: "utf8", timeout: 20000,
  });
}
const jsonOf = (s) => { try { return JSON.parse(String(s).trim()); } catch { return null; } };
{
  const sb = sandbox(); const out = sb.mk("personal");
  setScope(sb.lively, "work_folders", [sb.mk("work")]);
  writeFileSync(join(sb.lively, "context.md"), "# 회사 맥락 STATIC-MARK\n");
  const stdout = runPreload(sb, out); const j = jsonOf(stdout);
  check("H1 범위 밖 시작 훅은 사람에게 한 줄(systemMessage)로 연결 방법을 남긴다", typeof j?.systemMessage === "string" && j.systemMessage.includes("/lively-connect"), stdout.slice(0, 200));
  check("H2 범위 밖이면 회사 맥락을 넣지 않는다", !stdout.includes("STATIC-MARK"));
  check("H3 AI 에게도 안내를 남긴다(그 폴더를 짚어)", typeof j?.hookSpecificOutput?.additionalContext === "string" && j.hookSpecificOutput.additionalContext.includes(out));
  check("H4 늦은 주입 표식을 세운다", existsSync(join(sb.tmp, "lively-hooks", "sess-1.scope-out")));
}
{
  const sb = sandbox(); const work = sb.mk("work"); const inside = sb.mk("work", "repo");
  setScope(sb.lively, "work_folders", [work]);
  writeFileSync(join(sb.lively, "context.md"), "# 회사 맥락 STATIC-MARK\n");
  const stdout = runPreload(sb, inside);
  check("H5 범위 안이면 종전처럼 회사 맥락을 넣고 알림은 없다", stdout.includes("STATIC-MARK") && !jsonOf(stdout)?.systemMessage, stdout.slice(0, 200));
}
{
  const sb = sandbox(); const out = sb.mk("personal");
  writeFileSync(join(sb.lively, "context.md"), "# 회사 맥락 STATIC-MARK\n");
  check("H6 설정 사본이 없으면 종전처럼 넣는다", runPreload(sb, out).includes("STATIC-MARK"));
}

// ══ 훅 실측: run-custom ══════════════════════════════════════════════════════
const prompt = (sid) => ({ session_id: sid, hook_event_name: "UserPromptSubmit", prompt: "오늘 할 일 정리해 줘" });
{
  const sb = sandbox(); const out = sb.mk("personal");
  setScope(sb.lively, "work_folders", []);
  const hits = await withGateway(async (gw, h) => { await runHook("run-custom.mjs", ["UserPromptSubmit"], childEnv(sb, out, { LIVELY_TOKEN: "tk", LIVELY_GATEWAY_URL: gw }), prompt("s7")); return h; });
  check("H7 범위 밖 run-custom 은 게이트웨이를 한 번도 안 부른다", hits.length === 0, JSON.stringify(hits));
}
{
  const sb = sandbox(); const work = sb.mk("work");
  setScope(sb.lively, "work_folders", [work]);
  const hits = await withGateway(async (gw, h) => { await runHook("run-custom.mjs", ["UserPromptSubmit"], childEnv(sb, work, { LIVELY_TOKEN: "tk", LIVELY_GATEWAY_URL: gw }), prompt("s8")); return h; });
  check("H8 범위 안 run-custom 은 커스텀 훅 목록을 묻는다(대조군 — 가짜 게이트웨이가 살아 있다)", hits.some((u) => u.startsWith("/api/ui/org/runner/hooks")), JSON.stringify(hits));
}
{
  const sb = sandbox(); const dir = sb.mk("was-outside");
  setScope(sb.lively, "work_folders", [dir]);   // 범위 밖으로 시작한 뒤 이 폴더를 등록한 상태
  rs.markStartedOutside("s9", join(sb.tmp, "lively-hooks"));
  const { out, hits } = await withGateway(async (gw, h) => ({ out: await runHook("run-custom.mjs", ["UserPromptSubmit"], childEnv(sb, dir, { LIVELY_TOKEN: "tk", LIVELY_GATEWAY_URL: gw }), prompt("s9")), hits: h }));
  check("H9 등록 뒤 첫 지시에 회사 맥락을 한 번 넣는다", out.includes("LATE-CTX") && hits.includes("/api/ui/org/preview"), out.slice(0, 200) + JSON.stringify(hits));
  check("H10 넣은 뒤엔 표식을 걷는다(두 번 넣지 않는다)", !rs.startedOutside("s9", join(sb.tmp, "lively-hooks")));
}

// ══ MCP 프록시 실측 — 줄 단위 JSON-RPC 로 직접 말을 건다 ═══════════════════════
function mcpChild(file, env) {
  const p = spawn(process.execPath, [join(CLI, file)], { env, stdio: ["pipe", "pipe", "pipe"] });
  const lines = []; let buf = "";
  p.stdout.on("data", (c) => { buf += c; let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l) { try { lines.push(JSON.parse(l)); } catch { /* */ } } } });
  const sendMsg = (m) => p.stdin.write(JSON.stringify(m) + "\n");
  const waitFor = async (pred, ms = 5000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { const hit = lines.find(pred); if (hit) return hit; await new Promise((r) => setTimeout(r, 25)); }
    return null;
  };
  return { p, lines, sendMsg, waitFor, stop: () => { try { p.stdin.end(); p.kill(); } catch { /* */ } } };
}
await withGateway(async (gw, hits) => {
  const sb = sandbox(); const dir = sb.mk("personal-repo");
  setScope(sb.lively, "work_folders", []);
  const c = mcpChild("lively-mcp-gateway.mjs", childEnv(sb, dir, { LIVELY_TOKEN: "tk", LIVELY_GATEWAY_URL: gw, LIVELY_SCOPE_WATCH_MS: "100", LIVELY_MCP_WATCH_MS: "60000" }));
  try {
    c.sendMsg({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    await c.waitFor((m) => m.id === 1);
    c.sendMsg({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const l1 = await c.waitFor((m) => m.id === 2);
    check("P1 범위 밖 프록시는 도구 0개 · 상류 요청 0", Array.isArray(l1?.result?.tools) && l1.result.tools.length === 0 && !hits.includes("/mcp"), JSON.stringify({ l1, hits }));
    c.sendMsg({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "probe_tool", arguments: {} } });
    const l3 = await c.waitFor((m) => m.id === 3);
    check("P1b 범위 밖에서 부르면 도구 오류로 답하고 상류엔 안 간다", l3?.result?.isError === true && !hits.includes("/mcp"), JSON.stringify(l3));
    setScope(sb.lively, "work_folders", [dir]);   // 세션 중간에 이 폴더를 등록
    const note = await c.waitFor((m) => m.method === "notifications/tools/list_changed", 4000);
    check("P2 폴더를 등록하면 목록을 다시 받으라고 알린다(list_changed)", !!note);
    c.sendMsg({ jsonrpc: "2.0", id: 4, method: "tools/list" });
    const l4 = await c.waitFor((m) => m.id === 4);
    check("P3 다시 받으면 상류 도구가 보인다", l4?.result?.tools?.some((t) => t.name === "probe_tool") && hits.includes("/mcp"), JSON.stringify({ l4, hits }));
  } finally { c.stop(); }
});
{
  const sb = sandbox(); const dir = sb.mk("personal-repo");
  setScope(sb.lively, "work_folders", []);
  const c = mcpChild("lively-mcp-local.mjs", childEnv(sb, dir, { LIVELY_SCOPE_WATCH_MS: "100" }));
  try {
    c.sendMsg({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    await c.waitFor((m) => m.id === 1);
    c.sendMsg({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const l = await c.waitFor((m) => m.id === 2);
    check("P4 범위 밖 mcp-local 은 도구 0개", Array.isArray(l?.result?.tools) && l.result.tools.length === 0, JSON.stringify(l));
    setScope(sb.lively, "work_folders", [dir]);
    c.sendMsg({ jsonrpc: "2.0", id: 3, method: "tools/list" });
    const l2 = await c.waitFor((m) => m.id === 3);
    check("P4b 등록하면 mcp-local 도구가 돌아온다(대조군)", (l2?.result?.tools?.length || 0) > 0, JSON.stringify(l2).slice(0, 200));
  } finally { c.stop(); }
}

// ══ CLI 실측 — 오프라인(게이트웨이 없음): 사본에 쌓이고 판정에 바로 반영 ═══════════
{
  const sb = sandbox(); const dir = sb.mk("company", "repo");
  setScope(sb.lively, "work_folders", []);
  const env = childEnv(sb, dir, { LIVELY_TOKEN: "", LIVELY_GATEWAY_URL: "" });
  const cli = (...a) => { try { execFileSync(process.execPath, [join(CLI, "lively.mjs"), ...a], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 20000 }); return ""; } catch (e) { return String(e.stderr || e.message).slice(0, 200); } };
  const e1 = cli("work-root", "add", dir);
  check("C1 lively work-root add 뒤엔 그 폴더가 켜진다", !e1 && decide(sb, dir).inScope, e1);
  const e2 = cli("work-root", "remove", dir);
  check("C2 lively work-root remove 뒤엔 그 폴더가 꺼진다", !e2 && !decide(sb, dir).inScope, e2);
}

// ══ 훅 실측 2 — 범위 밖 시작 훅의 서버 접촉 · 나머지 훅의 게이트(밖 0 / 안 대조군) ══════════
await withGateway(async (gw, hits, reqs) => {
  const sb = sandbox(); const out = sb.mk("personal-h11");
  setScope(sb.lively, "work_folders", []);
  writeFileSync(join(sb.lively, "machine-id"), "11111111-2222-3333-4444-555555555555\n");
  //  ⚠ 비동기로 띄운다 — 가짜 게이트웨이가 이 프로세스에서 돈다. execFileSync 로 막으면 자식의 요청이 응답을 못 받는다.
  await runHook("session-preload.mjs", [], childEnv(sb, out, { LIVELY_HOME: "", LIVELY_TOKEN: "tk", LIVELY_GATEWAY_URL: gw }),
    { session_id: "s11", cwd: out, hook_event_name: "SessionStart", source: "startup" });
  check("H11 범위 밖 시작 훅이 서버에 보내는 건 이 컴퓨터 설정 조회뿐이다(세션·워크스페이스 헤더 없음)",
    reqs.length >= 1 && reqs.every((r) => r.url.startsWith("/api/ui/me/local-scope?machine_id=") && !r.headers["x-lively-session"] && !r.headers["x-lively-workspace"]),
    JSON.stringify(reqs.map((r) => [r.method, r.url, r.headers["x-lively-session"] || ""])));
});
function runWorkFlag(sb, dir, sid) {
  execFileSync(process.execPath, [join(HERE, "work-flag.mjs")], {
    input: JSON.stringify({ session_id: sid, hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: join(dir, "a.txt") }, cwd: dir }),
    env: childEnv(sb, dir, { LIVELY_HOME: "" }), encoding: "utf8", timeout: 20000 });
  return existsSync(join(sb.tmp, "lively-hooks", `${sid}.worked`));
}
{
  const sb = sandbox(); const work = sb.mk("work"); const out = sb.mk("personal");
  setScope(sb.lively, "work_folders", [work]);
  check("H12 범위 밖 work-flag 는 작업 표식을 안 남긴다", !runWorkFlag(sb, out, "wf-out"));
  check("H13 범위 안 work-flag 는 작업 표식을 남긴다(대조군)", runWorkFlag(sb, work, "wf-in"));
}
function runStop(sb, dir, sid) {
  mkdirSync(join(sb.tmp, "lively-hooks"), { recursive: true });
  writeFileSync(join(sb.tmp, "lively-hooks", `${sid}.worked`), "");
  //  «라이블리 도구를 썼다» 표식도 세운다 — 종전 자가 게이팅만으로도 붙잡히는 세션이어야 범위 판정이 실제로 막는지 보인다
  //  (이게 없으면 범위 판정을 지워도 종전 게이팅이 같은 답을 내 테스트가 아무것도 못 본다 — 변이로 확인).
  writeFileSync(join(sb.tmp, "lively-hooks", `${sid}.lively`), "");
  return execFileSync(process.execPath, [join(HERE, "stop-writeback-gate.mjs")], {
    input: JSON.stringify({ session_id: sid, hook_event_name: "Stop", cwd: dir, stop_hook_active: false }),
    env: childEnv(sb, dir, { LIVELY_HOME: "" }), encoding: "utf8", timeout: 20000 });
}
{
  const sb = sandbox(); const work = sb.mk("work"); const out = sb.mk("personal");
  setScope(sb.lively, "work_folders", [work]);
  check("H14 범위 밖 종료 훅은 «기록하라» 를 말하지 않는다", !jsonOf(runStop(sb, out, "st-out"))?.decision);
  check("H15 범위 안 종료 훅은 일한 세션을 한 번 붙잡는다(대조군)", jsonOf(runStop(sb, work, "st-in"))?.decision === "block");
}
async function runSync(sb, dir, gw, args = []) {
  await runHook("sync-harness-assets.mjs", ["--harness", "claude", ...args], childEnv(sb, dir, { LIVELY_TOKEN: "tk", LIVELY_GATEWAY_URL: gw }), {});
}
await withGateway(async (gw, hits) => {
  const sb = sandbox(); const work = sb.mk("work"); const out = sb.mk("personal");
  setScope(sb.lively, "work_folders", [work]);
  const assetHits = () => hits.filter((u) => u.startsWith("/api/ui/org/runner/assets")).length;
  await runSync(sb, out, gw);
  const outHits = assetHits();
  await runSync(sb, work, gw);
  const inHits = assetHits() - outHits;
  await runSync(sb, out, gw, ["--preload"]);
  const preloadHits = assetHits() - outHits - inHits;
  check("H16 범위 밖 스킬 동기화는 서버에 안 묻는다", outHits === 0, JSON.stringify(hits));
  check("H17 범위 안 스킬 동기화는 묻는다(대조군)", inHits >= 1, JSON.stringify(hits));
  check("H18 설치기의 미리 받기(--preload)는 작업 폴더 밖에서 깔아도 받는다", preloadHits >= 1, JSON.stringify(hits));
});

// ══ 어댑터 — 세션 폴더를 훅에 LIVELY_SESSION_DIR 로 넘기나(스텁 훅이 받은 env 로 잰다) ════════
function adapterSandbox() {
  const sb = sandbox(); const hooks = join(sb.lively, "hooks"); const cap = join(sb.root, "cap.log");
  mkdirSync(hooks, { recursive: true });
  for (const f of ["session-preload.mjs", "sync-harness-assets.mjs", "run-custom.mjs", "work-flag.mjs", "stop-writeback-gate.mjs"]) {
    writeFileSync(join(hooks, f), `import { appendFileSync } from "node:fs";\n`
      + `appendFileSync(${JSON.stringify(cap)}, JSON.stringify({ f: ${JSON.stringify(f)}, dir: process.env.LIVELY_SESSION_DIR || "" }) + "\\n");\n`
      + `process.stdin.resume(); process.stdin.on("end", () => process.exit(0)); setTimeout(() => process.exit(0), 2000);\n`);
  }
  const seen = () => { try { return readFileSync(cap, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  return { sb, seen };
}
import { readFileSync } from "node:fs";
for (const [name, file, event, payload] of [
  ["A1 안티그래비티", "antigravity-adapter.mjs", "PreInvocation", (d) => ({ conversationId: "c1", invocationNum: 0, workspacePaths: [d] })],
  ["A2 그록", "grok-adapter.mjs", "SessionStart", (d) => ({ sessionId: "g1", cwd: d, source: "startup" })],
  ["A3 커서(작업 공간 첫 폴더가 이벤트 cwd 보다 먼저)", "cursor-adapter.mjs", "sessionStart", (d) => ({ session_id: "u1", workspace_roots: [d], cwd: "/elsewhere" })],
]) {
  const { sb, seen } = adapterSandbox(); const dir = sb.mk("ws", "repo");
  try {
    execFileSync(process.execPath, [join(HERE, file), event], { input: JSON.stringify(payload(dir)), env: childEnv(sb, dir, { CLAUDE_PROJECT_DIR: "" }), encoding: "utf8", timeout: 30000 });
  } catch { /* 어댑터는 fail-open 이다 — 결과는 스텁 기록으로 잰다 */ }
  const pre = seen().find((x) => x.f === "session-preload.mjs");
  check(`${name} 어댑터가 시작 훅에 세션 폴더를 넘긴다`, pre?.dir === dir, JSON.stringify(seen()));
}

// ══ 설치·제거 — 조직 목록의 ~ 줄 · «여기 연결» 커맨드 꼴 · 사용자 파일 보존 · 제거 대칭 ══════════
import { pathToFileURL } from "node:url";
const SETUP = join(HERE, "..", "setup");
function inChild(sb, code) {
  const out = execFileSync(process.execPath, ["--input-type=module", "-e",
    `const ui = await import(${JSON.stringify(pathToFileURL(join(SETUP, "user-install.mjs")).href)});\n`
    + `const un = await import(${JSON.stringify(pathToFileURL(join(SETUP, "user-uninstall.mjs")).href)});\n${code}`],
  { env: childEnv(sb, sb.home, { LIVELY_HOME: sb.home }), encoding: "utf8", timeout: 30000, cwd: sb.root });
  return JSON.parse(out.trim().split("\n").pop());
}
{
  const sb = sandbox(); const x = join(sb.home, "x", "deep"); mkdirSync(x, { recursive: true });
  inChild(sb, `ui.seedWorkRoots(["~/x", "/abs/y"]); console.log("{}");`);
  const lines = readFileSync(join(sb.lively, "work-roots"), "utf8").split("\n").map((l) => l.trim());
  setScope(sb.lively, "work_folders");
  check("I1 조직 목록의 `~/x` 줄은 펴지 않고 그대로 두어 그 컴퓨터 홈 아래 x 가 켜진다",
    lines.includes("~/x") && !lines.some((l) => l.includes("/~/")) && decide(sb, x).inScope, JSON.stringify(lines));
}
{
  const sb = sandbox();
  const r = inChild(sb, `console.log(JSON.stringify(Object.fromEntries(["claude","codex","cursor","frontmatter"].map((f) => [f, ui.connectCommandFiles({ format: f, shim: "/h/.lively/bin/lively", win: false })]))));`);
  const c = r.claude[0].text, x = r.codex[0].text, u = r.cursor[0].text;
  const once = (t) => t.split("$ARGUMENTS").length - 1 === 1;
  check("I2a 클로드 커맨드 — frontmatter·미리 허용·자리표시 한 번", c.startsWith("---\n") && c.includes("allowed-tools: Bash(lively work-root add:*)") && once(c));
  check("I2b 코덱스 프롬프트 — frontmatter 없음(프롬프트로 새지 않게)·자리표시 한 번", !x.startsWith("---") && once(x));
  check("I2c 커서 커맨드 — 첫 줄이 제목", u.split("\n")[0] === r.cursor[0].text.split("\n")[0] && !u.startsWith("---") && u.split("\n")[0].includes("작업 폴더"));
}
{
  const sb = sandbox(); const dir = join(sb.root, "cmds"); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "lively-disconnect.md"), "내가 만든 커맨드\n");
  const r = inChild(sb, `
    const { existsSync, readFileSync } = await import("node:fs");
    const d = ${JSON.stringify(dir)};
    ui.writeConnectCommands(d, "claude", "Claude");
    const afterWrite = { connect: existsSync(d + "/lively-connect.md"), user: readFileSync(d + "/lively-disconnect.md", "utf8") };
    un.removeConnectCommands(d, "Claude");
    console.log(JSON.stringify({ afterWrite, afterRemove: { connect: existsSync(d + "/lively-connect.md"), user: existsSync(d + "/lively-disconnect.md") } }));`);
  check("I3a 설치는 우리 커맨드를 깔고 같은 이름의 사용자 파일은 안 덮는다", r.afterWrite.connect && r.afterWrite.user === "내가 만든 커맨드\n", JSON.stringify(r));
  check("I3b 제거는 우리 표식이 있는 파일만 지운다", !r.afterRemove.connect && r.afterRemove.user, JSON.stringify(r));
}
{
  const mark = (f) => (readFileSync(join(SETUP, f), "utf8").match(/CONNECT_MARK = "([^"]+)"/) || [])[1];
  check("I4 설치·제거기의 커맨드 표식이 같은 글자다", !!mark("user-install.mjs") && mark("user-install.mjs") === mark("user-uninstall.mjs"));
}
{
  const kit = readFileSync(join(HERE, "record-scope.mjs"), "utf8"), srv = readFileSync(join(HERE, "..", "..", "src", "org", "store", "record-scope.ts"), "utf8");
  const num = (s, re) => Number((s.match(re) || [])[1]);
  check("K1 작업 폴더 상한(개수·길이)이 서버와 같다",
    num(kit, /MAX_ROOTS = (\d+)/) === num(srv, /MAX_WORK_ROOTS = (\d+)/) && num(kit, /MAX_ROOT_LEN = (\d+)/) === num(srv, /MAX_WORK_ROOT_LEN = (\d+)/) && num(kit, /MAX_ROOTS = (\d+)/) > 0);
}

// ══ CLI 2 — lively scope · 루트 통째 등록 거절 ═════════════════════════════════
{
  const sb = sandbox(); const dir = sb.mk("company");
  setScope(sb.lively, "work_folders", []);
  const env = childEnv(sb, dir, { LIVELY_TOKEN: "", LIVELY_GATEWAY_URL: "" });
  const run = (...a) => { try { execFileSync(process.execPath, [join(CLI, "lively.mjs"), ...a], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 20000 }); return 0; } catch (e) { return e.status ?? -1; } };
  const c3 = run("scope", "anywhere");
  check("C3 ★ lively scope anywhere 는 거절한다(종료 2) — 방식은 조직이 정한다 · 사본도 판정도 그대로",
    c3 === 2 && rs.effectiveSettings(sb.lively)?.scope === "work_folders" && !rs.readScopeFile(sb.lively)?.pending && !decide(sb, dir).inScope, String(c3));
  const code = run("work-root", "add", "/");
  check("C4 / 를 통째로 등록하려 하면 거절한다(종료 2 · 목록 그대로)", code === 2 && !rs.effectiveSettings(sb.lively).work_roots.includes("/"), String(code));
}

// ══ CLI 4 — 방식에 맞춘 켜기·끄기(work-root add|remove) · 조직 줄 ═════════════════
{
  const sb = sandbox(); const ex = sb.mk("personal"); const dir = sb.mk("personal", "diary"); const other = sb.mk("company");
  setScope(sb.lively, "anywhere", [], null, { exclude_roots: [ex], org: { work_roots: [], exclude_roots: [] } });
  const env = childEnv(sb, other, { LIVELY_TOKEN: "", LIVELY_GATEWAY_URL: "" });
  //  CLI 의 안내(say)는 stderr 로 나간다 — 둘 다 모아 본다.
  const run = (...a) => { const r = spawnSync(process.execPath, [join(CLI, "lively.mjs"), ...a], { env, encoding: "utf8", timeout: 20000 }); return { code: r.status ?? -1, out: String(r.stdout || "") + String(r.stderr || "") }; };
  const r1 = run("work-root", "add", dir);
  check("C6 «어디서나» — 제외 폴더 아래에서 켜기는 바꾸지 않고 품은 제외 폴더를 알려 준다",
    r1.code === 0 && r1.out.includes(ex) && !rs.readScopeFile(sb.lively)?.pending && !decide(sb, dir).inScope, r1.out);
  const r2 = run("work-root", "add", ex);
  const p2 = rs.readScopeFile(sb.lively)?.pending || {};
  check("C7 «어디서나» — 제외 폴더 그 자체를 켜면 제외 목록에서 뺀다(오프라인 → pending · 판정 즉시 켬)",
    r2.code === 0 && (p2.exclude_remove || []).includes(ex) && decide(sb, dir).inScope, JSON.stringify({ p2, out: r2.out }));
  const r3 = run("work-root", "remove", other);
  const p3 = rs.readScopeFile(sb.lively)?.pending || {};
  check("C8 «어디서나» — 끄기는 제외 목록에 넣는다(판정 즉시 끔)", r3.code === 0 && (p3.exclude_add || []).includes(other) && !decide(sb, other).inScope, JSON.stringify(p3));
  check("C9 «어디서나» — 홈을 통째로 제외하려 하면 거절한다(종료 2)", run("work-root", "remove", sb.home).code === 2);
}
{
  //  조직 줄은 서버가 원래 글자로 견준다 — 이 컴퓨터에서 편 경로가 아니라 `~/company` 그대로 보내야 «이 컴퓨터에서 끔» 이 된다.
  const sb = sandbox(); const company = join(sb.home, "company"); mkdirSync(company, { recursive: true });
  writeFileSync(join(sb.lively, "work-roots"), "# 헤더\n~/company\n");
  setScope(sb.lively, "work_folders", ["~/company"], null, { org: { work_roots: ["~/company"], exclude_roots: [] } });
  const env = childEnv(sb, company, { LIVELY_TOKEN: "", LIVELY_GATEWAY_URL: "" });
  //  CLI 의 안내(say)는 stderr 로 나간다 — 둘 다 모아 본다.
  const run = (...a) => { const r = spawnSync(process.execPath, [join(CLI, "lively.mjs"), ...a], { env, encoding: "utf8", timeout: 20000 }); return { code: r.status ?? -1, out: String(r.stdout || "") + String(r.stderr || "") }; };
  const r = run("work-root", "remove", company);
  const p = rs.readScopeFile(sb.lively)?.pending || {};
  check("C10 조직 작업 폴더 끄기 — 원래 글자(~/company)를 보내고, 설치 파일 줄이 있어도 끔",
    r.code === 0 && (p.remove || []).includes("~/company") && !decide(sb, company).inScope && r.out.includes("조직"), JSON.stringify({ p, out: r.out }));
  const r2 = run("work-root", "add", company);
  check("C11 다시 켜기 — 판정 즉시 켬", r2.code === 0 && decide(sb, company).inScope, r2.out);
}

// ══ CLI 3 — `lively run` 이 띄운 하네스가 LIVELY_RUN=1 을 받는다(가짜 claude 가 받은 env 로 잰다) ═════════
if (!WIN) {
  //  가짜 하네스는 샌드박스 tmp 안에 둔다 — 테스트용 HostEffects(sandbox)는 샌드박스 홈·tmp 안의 실행 파일만 띄운다(lively.mjs has()).
  const sb = sandbox(); const dir = sb.mk("personal-run"); const bin = join(sb.tmp, "bin"); mkdirSync(bin, { recursive: true }); const got = join(sb.root, "run-env.txt");
  writeFileSync(join(bin, "claude"), `#!/bin/sh\nprintf '%s' "$LIVELY_RUN" > ${JSON.stringify(got)}\n`, { mode: 0o755 });
  try {
    execFileSync(process.execPath, [join(CLI, "lively.mjs"), "run", "--normal", "--harness", "claude"], {
      env: { ...childEnv(sb, dir, { LIVELY_TOKEN: "", LIVELY_GATEWAY_URL: "" }), PATH: `${bin}:${process.env.PATH}` }, cwd: dir,
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 20000 });
  } catch { /* 하네스 종료 코드는 관심 밖 — 받은 env 로 잰다 */ }
  let v = null; try { v = readFileSync(got, "utf8"); } catch { /* 안 불림 */ }
  check("C5 lively run 이 띄운 하네스는 LIVELY_RUN=1 을 받는다(라이블리가 띄운 세션)", v === "1", String(v));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
