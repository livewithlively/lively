// 세션 폴더 사전 신뢰 (#1631) — 엣지 표 행마다 한 검사.
//  사양: 우리가 만든 폴더만 · 멱등(이미 true 면 안 씀) · 비파괴(다른 키 보존) · 못 읽으면 새로 만든다.
//  ⑭⑮ 는 «우리가 만든 폴더만» 을 **인자로** 받게 한 뒤의 계약이다(#2478) — 그전엔 이 축이 주석에만 있었고
//   호출부가 그 보증 없이 불러 화면 수락층의 가드가 우회됐다.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { planTrustPatch, planAgyTrustPatch, ensureFolderTrusted, TRUST_KEY, AGY_TRUST_KEY, type TrustIo, planCodexTrustPatch,
  planClaudeOnboardedPatch, ensureClaudeOnboarded, ONBOARDED_KEY } from "./harness-trust.js";

const DIR = "/box/a";
const parse = (p: { write: boolean; text?: string }) => JSON.parse((p as { text: string }).text);

test("① 파일이 없으면 새로 만든다", () => {
  const p = planTrustPatch(null, DIR);
  assert.equal(p.write, true);
  assert.equal(parse(p).projects[DIR][TRUST_KEY], true);
});

test("② projects 가 비어 있으면 항목만 추가한다", () => {
  const p = planTrustPatch(JSON.stringify({ projects: {} }), DIR);
  assert.equal(p.write, true);
  assert.deepEqual(Object.keys(parse(p).projects), [DIR]);
});

test("③ 이미 신뢰돼 있으면 **쓰지 않는다**(멱등)", () => {
  const cur = JSON.stringify({ projects: { [DIR]: { [TRUST_KEY]: true } } });
  assert.deepEqual(planTrustPatch(cur, DIR), { write: false });
});

test("④ 다른 프로젝트 항목을 보존한다", () => {
  const cur = JSON.stringify({ projects: { "/other": { [TRUST_KEY]: true, allowedTools: ["x"] } } });
  const got = parse(planTrustPatch(cur, DIR));
  assert.equal(got.projects["/other"][TRUST_KEY], true);
  assert.deepEqual(got.projects["/other"].allowedTools, ["x"]);
  assert.equal(got.projects[DIR][TRUST_KEY], true);
});

test("⑤ 같은 항목의 다른 키를 보존한다", () => {
  const cur = JSON.stringify({ projects: { [DIR]: { allowedTools: ["Bash"], lastCost: 12 } } });
  const got = parse(planTrustPatch(cur, DIR));
  assert.deepEqual(got.projects[DIR].allowedTools, ["Bash"]);
  assert.equal(got.projects[DIR].lastCost, 12);
  assert.equal(got.projects[DIR][TRUST_KEY], true);
});

test("⑥ 최상위의 다른 키를 보존한다 — 여긴 로그인 정보도 사는 파일이다", () => {
  const cur = JSON.stringify({ oauthAccount: { uuid: "u1" }, numStartups: 7, projects: {} });
  const got = parse(planTrustPatch(cur, DIR));
  assert.deepEqual(got.oauthAccount, { uuid: "u1" });
  assert.equal(got.numStartups, 7);
});

test("⑦ 깨진 JSON 이면 새로 만든다(던지지 않는다)", () => {
  const p = planTrustPatch("{ this is not json", DIR);
  assert.equal(p.write, true);
  assert.equal(parse(p).projects[DIR][TRUST_KEY], true);
});

test("⑧ 최상위가 객체가 아니면(배열·문자열) 새로 만든다", () => {
  for (const cur of ["[]", '"nope"', "42"]) {
    const p = planTrustPatch(cur, DIR);
    assert.equal(p.write, true, `현재값 ${cur}`);
    assert.equal(parse(p).projects[DIR][TRUST_KEY], true);
  }
});

test("⑨ 명시적 false 는 true 로 올린다", () => {
  const cur = JSON.stringify({ projects: { [DIR]: { [TRUST_KEY]: false } } });
  const p = planTrustPatch(cur, DIR);
  assert.equal(p.write, true);
  assert.equal(parse(p).projects[DIR][TRUST_KEY], true);
});

test("⑩ 경로가 비면 아무것도 하지 않는다", () => {
  assert.deepEqual(planTrustPatch(null, ""), { write: false });
  assert.deepEqual(planTrustPatch(null, "   "), { write: false });
});

// ── seam 배선 — 실제로 읽고 쓰는지, 그리고 실패를 삼키는지 ──
test("⑪ 쓰기가 실제로 그 파일로 나간다", async () => {
  const wrote: Array<[string, string]> = [];
  const io: TrustIo = { read: async () => null, write: async (p, t) => { wrote.push([p, t]); } };
  assert.equal(await ensureFolderTrusted(io, "/cfg/.claude.json", DIR, true, "claude"), true);
  assert.equal(wrote.length, 1);
  assert.equal(wrote[0][0], "/cfg/.claude.json");
  assert.equal(JSON.parse(wrote[0][1]).projects[DIR][TRUST_KEY], true);
});

test("⑫ 이미 신뢰돼 있으면 write 를 **한 번도** 부르지 않는다", async () => {
  let calls = 0;
  const io: TrustIo = {
    read: async () => JSON.stringify({ projects: { [DIR]: { [TRUST_KEY]: true } } }),
    write: async () => { calls++; },
  };
  assert.equal(await ensureFolderTrusted(io, "/cfg/.claude.json", DIR, true, "claude"), false);
  assert.equal(calls, 0);
});

test("⑬ 읽기·쓰기가 던져도 세션을 막지 않는다(false 를 돌려줄 뿐)", async () => {
  const readThrows: TrustIo = { read: async () => { throw new Error("EACCES"); }, write: async () => {} };
  assert.equal(await ensureFolderTrusted(readThrows, "/cfg/.claude.json", DIR, true, "claude"), false);
  const writeThrows: TrustIo = { read: async () => null, write: async () => { throw new Error("EROFS"); } };
  assert.equal(await ensureFolderTrusted(writeThrows, "/cfg/.claude.json", DIR, true, "claude"), false);
});

// ── «우리가 만든 폴더만» — 판정이 거짓이면 파일에 손대지 않는다(#2478) ──
//  왜 read 까지 세나: 사양이 «읽지도 쓰지도 않는다» 다. 쓰기만 막으면 나중에 누가 '읽어서 판단' 을 넣을 때
//  이 테스트가 통과해 버린다 — 사람의 폴더는 판정 대상 자체가 아니다.
test("⑭ allowed=false 면 읽지도 쓰지도 않는다", async () => {
  let reads = 0, writes = 0;
  const io: TrustIo = { read: async () => { reads++; return null; }, write: async () => { writes++; } };
  assert.equal(await ensureFolderTrusted(io, "/cfg/.claude.json", DIR, false, "claude"), false);
  assert.equal(reads, 0, "사람의 폴더는 읽지도 않는다");
  assert.equal(writes, 0, "사람의 폴더를 대신 신뢰했다");
});

test("⑮ allowed=false 는 이미 있는 설정을 건드리지 않는다", async () => {
  const cur = JSON.stringify({ projects: { "/other": { [TRUST_KEY]: true } } });
  let wrote: string | null = null;
  const io: TrustIo = { read: async () => cur, write: async (_p, t) => { wrote = t; } };
  assert.equal(await ensureFolderTrusted(io, "/cfg/.claude.json", DIR, false, "claude"), false);
  assert.equal(wrote, null);
});

// ── antigravity — 자리도 형식도 다르다(#2478). claude 판과 **대칭으로** 못박는다 ──
//  실측(agy 1.1.x): ~/.gemini/antigravity-cli/settings.json 의 `trustedWorkspaces` 는 절대경로 **배열**이고,
//  같은 파일에 model·permissions 같은 **사람의 설정이 함께 산다**.
const AGY = (o: unknown) => JSON.stringify(o);

test("⑯ agy — 파일이 없으면 목록을 새로 만든다", () => {
  const p = planAgyTrustPatch(null, DIR);
  assert.equal(p.write, true);
  assert.deepEqual(parse(p)[AGY_TRUST_KEY], [DIR]);
});

test("⑰ agy — 이미 목록에 있으면 쓰지 않는다(멱등)", () => {
  assert.deepEqual(planAgyTrustPatch(AGY({ [AGY_TRUST_KEY]: ["/other", DIR] }), DIR), { write: false });
});

test("⑱ agy — 사람의 설정(model·permissions)과 기존 항목을 보존한다", () => {
  const cur = AGY({ model: "gemini-3.7-flash-high", permissions: { x: 1 }, [AGY_TRUST_KEY]: ["/other"] });
  const got = parse(planAgyTrustPatch(cur, DIR));
  assert.equal(got.model, "gemini-3.7-flash-high");
  assert.deepEqual(got.permissions, { x: 1 });
  assert.deepEqual(got[AGY_TRUST_KEY], ["/other", DIR]);
});

test("⑲ agy — 목록이 배열이 아니어도 다른 키는 살린다", () => {
  const got = parse(planAgyTrustPatch(AGY({ model: "m", [AGY_TRUST_KEY]: "이상한값" }), DIR));
  assert.equal(got.model, "m");
  assert.deepEqual(got[AGY_TRUST_KEY], [DIR]);
});

test("⑳ agy — 배열 안의 문자열 아닌 항목은 버린다", () => {
  const got = parse(planAgyTrustPatch(AGY({ [AGY_TRUST_KEY]: ["/other", 7, null, { a: 1 }] }), DIR));
  assert.deepEqual(got[AGY_TRUST_KEY], ["/other", DIR]);
});

test("㉑ agy — 깨진 JSON 이면 새로 만든다 · 경로가 비면 아무것도 안 한다", () => {
  assert.deepEqual(parse(planAgyTrustPatch("{망가짐", DIR))[AGY_TRUST_KEY], [DIR]);
  assert.deepEqual(planAgyTrustPatch(null, "  "), { write: false });
});

test("㉒ agy — 실제로 그 파일로 나간다", async () => {
  const wrote: Array<[string, string]> = [];
  const io: TrustIo = { read: async () => null, write: async (p, t) => { wrote.push([p, t]); } };
  const f = "/home/box_x/.gemini/antigravity-cli/settings.json";
  assert.equal(await ensureFolderTrusted(io, f, DIR, true, "antigravity"), true);
  assert.equal(wrote[0][0], f);
  assert.deepEqual(JSON.parse(wrote[0][1])[AGY_TRUST_KEY], [DIR]);
});

// ── codex (#4135) — TOML. 실측 2026-09-24: 신뢰 대화상자에서 «Yes, continue» 를 고르면 config.toml 끝에 테이블이 붙는다.
test("㉔ codex — 빈 파일·기존 설정 끝에 [projects.\"…\"] 테이블을 덧붙인다(나머지는 한 글자도 안 건드린다)", () => {
  const got = planCodexTrustPatch(null, DIR);
  assert.deepEqual(got, { write: true, text: `[projects."${DIR}"]\ntrust_level = "trusted"\n` });
  const keep = 'model = "gpt-5.6-sol"\n\n[mcp_servers.lively]\ncommand = "lively"\n';
  const p2 = planCodexTrustPatch(keep, DIR);
  assert.ok(p2.write && p2.text.startsWith(keep), "기존 내용이 앞에 그대로 남는다");
  assert.ok(p2.write && p2.text.endsWith(`[projects."${DIR}"]\ntrust_level = "trusted"\n`));
});

test("㉕ codex — 그 경로의 테이블이 이미 있으면 아무것도 안 한다(중복 테이블 = TOML 파손 = codex 즉사)", () => {
  const cur = `[projects."${DIR}"]\ntrust_level = "trusted"\n`;
  assert.deepEqual(planCodexTrustPatch(cur, DIR), { write: false });
  //  사람이 «신뢰 안 함» 으로 적어 둔 것도 그대로 둔다 — 그건 사람의 결정이다.
  assert.deepEqual(planCodexTrustPatch(`[projects."${DIR}"]\ntrust_level = "untrusted"\n`, DIR), { write: false });
  //  리터럴 문자열(사람이 손으로 적은 판)도 «이미 있다» 로 본다.
  assert.deepEqual(planCodexTrustPatch(`[projects.'${DIR}']\ntrust_level = "trusted"\n`, DIR), { write: false });
  //  다른 경로의 테이블은 «없다» — 덧붙인다.
  assert.equal(planCodexTrustPatch(`[projects."/other/dir"]\ntrust_level = "trusted"\n`, DIR).write, true);
});

test("㉖ codex — 줄바꿈 없이 끝난 파일에도 안전하게 붙이고, TOML 에 못 적는 경로는 포기한다", () => {
  const p = planCodexTrustPatch('model = "x"', DIR);
  assert.ok(p.write && p.text.startsWith('model = "x"\n\n[projects.'), "줄바꿈을 먼저 넣는다");
  assert.deepEqual(planCodexTrustPatch(null, "/bad\npath"), { write: false });
  assert.deepEqual(planCodexTrustPatch(null, "  "), { write: false });
  //  따옴표·역슬래시가 든 경로는 TOML 기본 문자열 규칙으로 탈출한다.
  const q = planCodexTrustPatch(null, '/a"b\\c');
  assert.ok(q.write && q.text.includes('[projects."/a\\"b\\\\c"]'), q.write ? q.text : "write:false");
});

test("㉗ codex — 실제로 config.toml 로 나간다", async () => {
  const wrote: Array<[string, string]> = [];
  const io: TrustIo = { read: async () => null, write: async (f, t) => { wrote.push([f, t]); } };
  const f = "/home/box_x/.codex/config.toml";
  assert.equal(await ensureFolderTrusted(io, f, DIR, true, "codex"), true);
  assert.equal(wrote[0][0], f);
  assert.ok(wrote[0][1].includes(`[projects."${DIR}"]`));
  //  사람이 고른 폴더(allowed=false)는 종전대로 손대지 않는다 — 신뢰는 그 사람이 대화상자에서 답한다.
  assert.equal(await ensureFolderTrusted(io, f, DIR, false, "codex"), false);
  assert.equal(wrote.length, 1);
});

// ★ 표에 없는 하네스는 **짐작해 쓰지 않는다** — 자리를 모르면 남의 설정 파일을 망가뜨린다.
test("㉓ 표에 없는 하네스는 읽지도 쓰지도 않는다", async () => {
  let reads = 0, writes = 0;
  const io: TrustIo = { read: async () => { reads++; return null; }, write: async () => { writes++; } };
  for (const h of ["grok", "opencode", "shell", ""]) {
    assert.equal(await ensureFolderTrusted(io, "/cfg/x.json", DIR, true, h), false, h);
  }
  assert.equal(reads, 0);
  assert.equal(writes, 0);
});

// ── #4940 화면 로그인 뒤 claude 첫 실행 안내 넘기기 (사양 C1~C9) ─────────────────────────────────
//  실측(2026-10-23 셀프호스트): 화면에서 로그인(oauthAccount 있음)한 프로필로 연 세션이 «글자 스타일 고르기» 에서 기다려
//   첫 지시가 영영 «전달하는 중…» 이었다. 로그인된 설정에만 · 비었을 때만 표식을 넣는다.
const LOGGED = { oauthAccount: { emailAddress: "ceo@x.io" }, mcpServers: { lively: { type: "stdio" } }, userID: "u1" };
const parsedOf = (p: { write: boolean; text?: string }) => (p.write ? JSON.parse((p as { text: string }).text) : null);

test("C1 로그인됨 · 표식 없음 · 테마 없음 → 표식 true · 테마 dark · 나머지 키 그대로", () => {
  assert.equal(ONBOARDED_KEY, "hasCompletedOnboarding", "Claude Code 와의 계약 글자 — 상수를 통해서만 견주면 오타가 살아남는다");
  const p = planClaudeOnboardedPatch(JSON.stringify(LOGGED));
  assert.equal(p.write, true);
  const d = parsedOf(p);
  assert.equal(d[ONBOARDED_KEY], true);
  assert.equal(d.theme, "dark");
  assert.deepEqual(d.oauthAccount, LOGGED.oauthAccount, "로그인 정보 보존");
  assert.deepEqual(d.mcpServers, LOGGED.mcpServers, "MCP 배선 보존");
  assert.equal(d.userID, "u1");
});

test("C2 로그인됨 · 표식 없음 · 테마 light → 표식만 넣고 테마는 그대로", () => {
  const d = parsedOf(planClaudeOnboardedPatch(JSON.stringify({ ...LOGGED, theme: "light" })));
  assert.equal(d[ONBOARDED_KEY], true);
  assert.equal(d.theme, "light");
});

test("C3·C4 표식이 이미 있으면(true 든 false 든) 쓰지 않는다", () => {
  assert.deepEqual(planClaudeOnboardedPatch(JSON.stringify({ ...LOGGED, [ONBOARDED_KEY]: true })), { write: false });
  assert.deepEqual(planClaudeOnboardedPatch(JSON.stringify({ ...LOGGED, [ONBOARDED_KEY]: false })), { write: false });
});

test("C5 로그인 안 됨(oauthAccount 없음·빈 값) → 쓰지 않는다(«Not logged in» 입력칸에 떨어뜨리지 않는다)", () => {
  assert.deepEqual(planClaudeOnboardedPatch(JSON.stringify({ mcpServers: {} })), { write: false });
  assert.deepEqual(planClaudeOnboardedPatch(JSON.stringify({ oauthAccount: null })), { write: false });
});

test("C6·C7 파일 없음 · 빈 것 · 깨진 JSON · 배열 최상위 → 쓰지 않는다", () => {
  for (const cur of [null, "", "   ", "{not json", "[1,2]", "\"str\""]) {
    assert.deepEqual(planClaudeOnboardedPatch(cur), { write: false }, String(cur));
  }
});

test("C8 실제로 그 파일로 나가고, 읽기·쓰기 실패는 던지지 않는다", async () => {
  const wrote: Array<[string, string]> = [];
  const f = "/home/lively/.lively/profiles/ceo/claude/.claude.json";
  const io: TrustIo = { read: async (p) => (p === f ? JSON.stringify(LOGGED) : null), write: async (p, t) => { wrote.push([p, t]); } };
  assert.equal(await ensureClaudeOnboarded(io, f), true);
  assert.equal(wrote.length, 1);
  assert.equal(wrote[0][0], f);
  assert.equal(JSON.parse(wrote[0][1])[ONBOARDED_KEY], true);
  //  다시 불러도(이미 넣은 파일) 쓰지 않는다 — 멱등
  const io2: TrustIo = { read: async () => wrote[0][1], write: async () => { wrote.push(["again", ""]); } };
  assert.equal(await ensureClaudeOnboarded(io2, f), false);
  assert.equal(wrote.length, 1);
  const boom: TrustIo = { read: async () => { throw new Error("EACCES"); }, write: async () => { throw new Error("EACCES"); } };
  assert.equal(await ensureClaudeOnboarded(boom, f), false);
  const wboom: TrustIo = { read: async () => JSON.stringify(LOGGED), write: async () => { throw new Error("EROFS"); } };
  assert.equal(await ensureClaudeOnboarded(wboom, f), false);
});

test("C9 배선 — createSession 의 claude 갈래가 신뢰 심기와 같은 io·설정 파일로, 폴더 신뢰 판정과 무관하게 부른다(매니지드 중계는 키트 몫)", () => {
  const src = readFileSync("src/terminal/sessions.ts", "utf8");   // 테스트는 레포 뿌리에서 돈다(dist 에서 실행 — 다른 배선 시험과 같은 방식)
  const i = src.indexOf("await ensureFolderTrusted(io, configFile, target, trustOk, harness.key);");
  assert.ok(i > 0, "신뢰 심기 호출 자리를 못 찾음");
  const after = src.slice(i, i + 900);
  //  부르는 줄 그 자체를 본다(주석에도 함수 이름이 나오므로 이름만 찾으면 엉뚱한 줄을 본다) — 신뢰 심기와 같은 깊이의 한 줄이어야 한다.
  const callLine = after.split("\n").find((l) => l.includes("await ensureClaudeOnboarded(")) ?? "";
  //  매니지드(중계)는 키트 심기가 이미 넣으므로 건너뛴다(memberExecConfigured — 멤버 경계 왕복을 하나 아낀다).
  assert.equal(callLine, '    if (harness.key === "claude" && !memberExecConfigured()) await ensureClaudeOnboarded(io, configFile);',
    "★ 세션을 띄우기 전에 첫 실행 표식을 안 넣는다(또는 폴더 신뢰 판정 안에 갇혔다) — 화면 로그인 뒤 첫 세션이 테마 고르기에서 멈춘다");
});
