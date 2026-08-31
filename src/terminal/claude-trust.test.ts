// 세션 폴더 사전 신뢰 (#1631) — 엣지 표 행마다 한 검사.
//  사양: 우리가 만든 폴더만 · 멱등(이미 true 면 안 씀) · 비파괴(다른 키 보존) · 못 읽으면 새로 만든다.
//  ⑭⑮ 는 «우리가 만든 폴더만» 을 **인자로** 받게 한 뒤의 계약이다(#2478) — 그전엔 이 축이 주석에만 있었고
//   호출부가 그 보증 없이 불러 화면 수락층의 가드가 우회됐다.
import test from "node:test";
import assert from "node:assert/strict";
import { planTrustPatch, ensureFolderTrusted, TRUST_KEY, type TrustIo } from "./claude-trust.js";

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
  assert.equal(await ensureFolderTrusted(io, "/cfg/.claude.json", DIR, true), true);
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
  assert.equal(await ensureFolderTrusted(io, "/cfg/.claude.json", DIR, true), false);
  assert.equal(calls, 0);
});

test("⑬ 읽기·쓰기가 던져도 세션을 막지 않는다(false 를 돌려줄 뿐)", async () => {
  const readThrows: TrustIo = { read: async () => { throw new Error("EACCES"); }, write: async () => {} };
  assert.equal(await ensureFolderTrusted(readThrows, "/cfg/.claude.json", DIR, true), false);
  const writeThrows: TrustIo = { read: async () => null, write: async () => { throw new Error("EROFS"); } };
  assert.equal(await ensureFolderTrusted(writeThrows, "/cfg/.claude.json", DIR, true), false);
});

// ── «우리가 만든 폴더만» — 판정이 거짓이면 파일에 손대지 않는다(#2478) ──
//  왜 read 까지 세나: 사양이 «읽지도 쓰지도 않는다» 다. 쓰기만 막으면 나중에 누가 '읽어서 판단' 을 넣을 때
//  이 테스트가 통과해 버린다 — 사람의 폴더는 판정 대상 자체가 아니다.
test("⑭ allowed=false 면 읽지도 쓰지도 않는다", async () => {
  let reads = 0, writes = 0;
  const io: TrustIo = { read: async () => { reads++; return null; }, write: async () => { writes++; } };
  assert.equal(await ensureFolderTrusted(io, "/cfg/.claude.json", DIR, false), false);
  assert.equal(reads, 0, "사람의 폴더는 읽지도 않는다");
  assert.equal(writes, 0, "사람의 폴더를 대신 신뢰했다");
});

test("⑮ allowed=false 는 이미 있는 설정을 건드리지 않는다", async () => {
  const cur = JSON.stringify({ projects: { "/other": { [TRUST_KEY]: true } } });
  let wrote: string | null = null;
  const io: TrustIo = { read: async () => cur, write: async (_p, t) => { wrote = t; } };
  assert.equal(await ensureFolderTrusted(io, "/cfg/.claude.json", DIR, false), false);
  assert.equal(wrote, null);
});
