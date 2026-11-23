import { strict as assert } from "node:assert";
import test from "node:test";
import { serverDeployDenial, editDenial, memberAppViolations } from "./member-app.js";
import { parseAppManifest, type LivelyAppManifest } from "./manifest.js";
import type { OrgApp } from "../org/store/apps.js";

// ── 앱 서버 올리기 권한 — serverDeployDenial (사양 S1~S5) ─────────────────────────────
//  서버 올리기(app_server_deploy)는 설치된 지금 판을 빌드해 올릴 뿐 판(매니페스트 · 코드)을 바꾸지 않는다. 그래서 확장 기능
//   (정기 작업 · 서버 worker · 바깥 호스트 …)이 든 앱도 관리자는 올릴 수 있어야 한다(S1) — 앱 고치기(editDenial)는 그런 앱을
//   관리자에게도 거절한다(배경).
//  이게 틀리면: S1 이 막히면 정기 작업이 든 앱은 관리자도 서버를 못 올린다(배경의 사고) · S2 가 새면 관리자만 설치하는 앱의 서버를
//   일반 구성원이 올린다 · S3 가 어긋나면 고치기 설정 · 책임자 규칙이 서버 올리기에서만 달라진다 · S4 가 새면 빌트인을 릴리스 밖에서
//   올린다 · S5 가 새면 무엇이 든지 모르는 앱(저장된 설명을 못 읽음)을 관리자라는 이유로 올린다.

type Who = { userId: string; scopes?: readonly string[] };

const base = {
  id: "memo", title: "메모", version: "1.0.0",
  ui: { pages: [{ key: "main", title: "메모", entry: "ui/index.html" }] },
  data: { tables: [{ name: "notes", columns: [{ name: "text", type: "text" }] }] },
};
const raw = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ ...base, ...extra });
const m = (extra: Record<string, unknown> = {}): LivelyAppManifest => parseAppManifest(raw(extra));

const headlessJob = { key: "daily", schedule: "0 9 * * *", run: { kind: "headless", prompt: "어제 기록을 요약해 줘" } };
const serverJob = { key: "sync", schedule: "0 * * * *", run: { kind: "server", route: "/sync" } };
const serverApp = {
  runtime: { entry: "server/worker.mjs" }, web: { server: true },
  jobs: [{ key: "sweep", schedule: "*/15 * * * *", run: { kind: "server", route: "/jobs/sweep", body: { days: 7 } } }],
};

/** 확장 기능(구성원 저장 앱에 허용하지 않는 선언)이 든 매니페스트 — [이름, 기본 매니페스트에 더할 선언]. */
const EXT: Array<[string, Record<string, unknown>]> = [
  ["jobs — 에이전트 정기 작업(headless)", { jobs: [headlessJob] }],
  ["jobs — 에이전트 정기 작업(inject)", { jobs: [{ key: "nudge", schedule: "0 9 * * 1", run: { kind: "inject", prompt: "이번 주 안내" } }] }],
  ["jobs — 서버 정기 작업(web.server 선언)", { web: { server: true }, jobs: [serverJob] }],
  ["서버 앱 — runtime + web.server + 서버 작업(본문 있음)", serverApp],
  ["runtime(서버 worker)", { runtime: { entry: "worker.mjs" } }],
  ["permissions.hosts", { permissions: { hosts: ["api.example.com"] } }],
  ["permissions.ext_tools", { permissions: { ext_tools: ["ext__slack__*"] } }],
  ["permissions.db_sources", { permissions: { db_sources: ["src.crm"] } }],
  ["harness", { harness: { plugin: "./" } }],
  ["tools.mcp_servers", { tools: { mcp_servers: [{ name: "x" }] } }],
  ["tools.http_tools", { tools: { http_tools: [{ name: "x" }] } }],
  ["sections", { sections: [{ key: "persona", file: "persona.md" }] }],
  ["system(셸 렌더러)", { system: { renderer: "browser" } }],
  ["csp.connect_domains", { csp: { connect_domains: ["api.example.com"] } }],
  ["여럿 함께 — jobs · runtime · hosts · sections", {
    jobs: [headlessJob], runtime: { entry: "worker.mjs" },
    permissions: { hosts: ["api.example.com"] }, sections: [{ key: "persona", file: "persona.md" }],
  }],
];

/** 확장 기능이 없는 매니페스트(화면 · 데이터와 구성원 앱에 허용된 선언만). */
const PLAIN: Array<[string, Record<string, unknown>]> = [
  ["화면 · 표만", {}],
  ["scopes · 라이블리 도구 · 알림 · frame/resource 도메인", {
    permissions: { scopes: ["memory"], tools: ["store_*", "knowledge_search"], notifications: true },
    csp: { frame_domains: ["example.com"], resource_domains: ["cdn.example.com"] },
    instances: { project: "optional", multiplicity: "multiple" },
  }],
  ["세션 AI 지침(agent)", { agent: { instructions: "HTML 을 만들면 이 앱에 올려라" } }],
];

const app = (over: Partial<OrgApp> = {}): OrgApp => ({
  id: "memo", title: "메모", version: "1.0.0", manifest: base, source: { kind: "inline" }, content_hash: null,
  status: "active", enabled: true, installed_by: "alice", installed_at: "", updated_at: "", updated_by: null,
  edit_mode: "all", edit_members: [], builtin_version: null, current_version_no: null, visibility: "all",
  published_version_no: null, published_at: null, published_by: null, draft_by: null, made_by: null,
  owner_member: null, build_session: null, origin_app_id: null, ...over,
});

/** 빌트인이 아닌 앱 — 고치기 설정 · 책임자 · 공개 범위를 바꿔 본다. */
const NON_BUILTIN: Array<[string, Partial<OrgApp>]> = [
  ["기본(전원 고침)", { edit_mode: "all" }],
  ["지정한 사람만 [carol]", { edit_mode: "members", edit_members: ["carol"] }],
  ["지정한 사람만 · 명단 빔", { edit_mode: "members", edit_members: [] }],
  ["책임자 alice", { owner_member: "alice", made_by: "alice" }],
  ["책임자 alice · 지정한 사람만 · 명단 빔", { edit_mode: "members", edit_members: [], owner_member: "alice" }],
  ["나만 보는 앱(책임자 alice)", { visibility: "me", owner_member: "alice", made_by: "alice" }],
];
/** 빌트인 앱(라이블리가 함께 싣는 기본 앱 — source 가 builtin). */
const BUILTIN: Array<[string, Partial<OrgApp>]> = [
  ["빌트인(릴리스 판 1.0.0)", { source: { kind: "builtin" }, builtin_version: "1.0.0", installed_by: null }],
  ["빌트인(판 번호 없음)", { source: { kind: "builtin" } }],
  ["빌트인 · 지정한 사람만 · 명단 빔", { source: { kind: "builtin" }, builtin_version: "1.0.0", edit_mode: "members", edit_members: [] }],
];

const admin: Who = { userId: "root", scopes: ["memory", "admin"] };
const bob: Who = { userId: "bob", scopes: ["memory"] };
const alice: Who = { userId: "alice", scopes: ["memory"] };
const carol: Who = { userId: "carol", scopes: ["memory"] };

const ADMINS: Array<[string, Who]> = [
  ["관리자(memory · admin)", admin],
  ["관리자(admin 하나)", { userId: "ops", scopes: ["admin"] }],
  ["관리자이면서 책임자 · 설치자 alice", { userId: "alice", scopes: ["admin", "memory"] }],
];
const MEMBERS: Array<[string, Who]> = [
  ["일반 구성원 bob", bob],
  ["책임자 · 설치자 alice(관리자 아님)", alice],
  ["고치기 명단의 carol", carol],
  ["scopes 없음", { userId: "dave" }],
  ["scopes 빔", { userId: "erin", scopes: [] }],
  ["runtime scope(관리 아님)", { userId: "frank", scopes: ["memory", "runtime"] }],
  ["이름이 admin 인 일반 구성원", { userId: "admin", scopes: ["memory"] }],
];

const show = (v: unknown): string => (v === null ? "null" : JSON.stringify(v));
const isRefusal = (v: string | null): boolean => typeof v === "string" && v.length > 0;
/** 여러 조합의 어긋남을 모아 한 번에 보인다(첫 실패에서 멈추면 어느 조합들이 틀렸는지 안 보인다). */
function reportBad(bad: string[], total: number): void {
  assert.ok(total > 0, "조합이 하나도 없다");
  assert.equal(bad.length, 0, `${bad.length}/${total} 조합이 사양과 다르다:\n  ${bad.slice(0, 25).join("\n  ")}${bad.length > 25 ? "\n  …" : ""}`);
}

/** who 마다 «editDenial 과 같은 거절» 인지 본다 — 거절이 아니거나 문자열이 다르면 어긋남. */
function expectSameRefusal(bad: string[], label: string, a: OrgApp, who: Who, cm: LivelyAppManifest | null): void {
  const got = serverDeployDenial(a, who, cm);
  const want = editDenial(a, who, cm);
  if (!isRefusal(want)) bad.push(`${label}: (기준) editDenial 이 거절이 아니다 — ${show(want)} · serverDeployDenial=${show(got)}`);
  else if (got !== want) bad.push(`${label}: serverDeployDenial=${show(got)} · editDenial=${show(want)}`);
}

// ── 전제 — 시험의 재료가 사양이 말하는 그 경우인지 ──────────────────────────────────

test("전제 — EXT 는 전부 확장 기능(memberAppViolations 가 비지 않음) · PLAIN 은 확장 기능 없음", () => {
  for (const [what, extra] of EXT) {
    assert.ok(memberAppViolations(m(extra)).length > 0, `${what}: 확장 기능이어야 하는데 위반이 없다`);
  }
  for (const [what, extra] of PLAIN) {
    assert.deepEqual(memberAppViolations(m(extra)), [], `${what}: 확장 기능이 없어야 한다`);
  }
});

test("전제(배경) — editDenial 은 확장 기능이 든 앱(빌트인 아님)을 관리자에게도 거절한다 — 서버 올리기가 이걸 그대로 쓰면 관리자도 못 올린다", () => {
  const bad: string[] = [];
  let total = 0;
  for (const [ew, extra] of EXT) for (const [aw, over] of NON_BUILTIN) for (const [ww, who] of ADMINS) {
    total++;
    const e = editDenial(app({ ...over, manifest: raw(extra) }), who, m(extra));
    if (!isRefusal(e)) bad.push(`${ew} · ${aw} · ${ww}: editDenial=${show(e)}`);
  }
  reportBad(bad, total);
});

// ── S1 ────────────────────────────────────────────────────────────────────────

test("S1 관리자 · 빌트인 아님 · 매니페스트 읽음 · 확장 기능 있음 → null — 확장 기능 종류 · 고치기 설정 · 책임자 · 공개 범위와 무관", () => {
  const bad: string[] = [];
  let total = 0;
  for (const [ew, extra] of EXT) for (const [aw, over] of NON_BUILTIN) for (const [ww, who] of ADMINS) {
    total++;
    const got = serverDeployDenial(app({ ...over, manifest: raw(extra) }), who, m(extra));
    if (got !== null) bad.push(`${ew} · ${aw} · ${ww}: ${show(got)}`);
  }
  reportBad(bad, total);
});

test("S1 판정은 넘겨받은 currentManifest 로 — 앱 행의 manifest 칸이 화면 · 표뿐이어도 currentManifest 에 확장 기능이 있으면 관리자는 null", () => {
  const bad: string[] = [];
  for (const [ew, extra] of EXT) {
    const got = serverDeployDenial(app(), admin, m(extra));
    if (got !== null) bad.push(`${ew}: ${show(got)}`);
  }
  reportBad(bad, EXT.length);
});

test("S1·S2 배경의 사고 — 정기 작업(에이전트 · 서버)이 든 앱: 관리자는 서버를 올리고(null), 같은 앱 · 같은 매니페스트라도 일반 구성원은 editDenial 의 거절 그대로", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["에이전트 정기 작업", { jobs: [headlessJob] }],
    ["서버 정기 작업", { web: { server: true }, jobs: [serverJob] }],
  ];
  for (const [what, extra] of cases) {
    const a = app({ manifest: raw(extra) });
    const cm = m(extra);
    assert.ok(isRefusal(editDenial(a, admin, cm)), `${what}: (기준) app_save 로는 관리자도 못 고친다`);
    assert.equal(serverDeployDenial(a, admin, cm), null, `${what}: 서버 올리기는 관리자에게 된다`);
    const forBob = serverDeployDenial(a, bob, cm);
    assert.ok(isRefusal(forBob), `${what}: 일반 구성원은 거절 — ${show(forBob)}`);
    assert.equal(forBob, editDenial(a, bob, cm), `${what}: 거절 까닭은 editDenial 과 같은 문자열`);
  }
});

// ── S2 ────────────────────────────────────────────────────────────────────────

test("S2 확장 기능이 든 앱(빌트인 아님) · 관리자 아님 → editDenial 과 같은 문자열(거절) — 책임자 · 설치자 · 고치기 명단의 사람 · 나만 보는 앱의 주인도", () => {
  const bad: string[] = [];
  let total = 0;
  for (const [ew, extra] of EXT) for (const [aw, over] of NON_BUILTIN) for (const [ww, who] of MEMBERS) {
    total++;
    expectSameRefusal(bad, `${ew} · ${aw} · ${ww}`, app({ ...over, manifest: raw(extra) }), who, m(extra));
  }
  reportBad(bad, total);
});

test("S2 관리자 판정은 scopes 의 \"admin\" 으로만 — userId 가 admin 이거나 다른 scope(runtime)가 있어도 관리자가 아니다", () => {
  const a = app({ manifest: raw({ jobs: [headlessJob] }) });
  const cm = m({ jobs: [headlessJob] });
  for (const who of [{ userId: "admin", scopes: ["memory"] }, { userId: "frank", scopes: ["memory", "runtime"] }, { userId: "dave" }] as Who[]) {
    const got = serverDeployDenial(a, who, cm);
    assert.ok(isRefusal(got), `${show(who)}: 거절이어야 한다 — ${show(got)}`);
    assert.equal(got, editDenial(a, who, cm));
  }
});

// ── S3 ────────────────────────────────────────────────────────────────────────

test("S3 확장 기능 없는 앱 → 누구든 editDenial 과 같은 결과(null 이든 문자열이든) — 빌트인 · 아님, 관리자 · 책임자 · 명단 · 일반 모두", () => {
  const bad: string[] = [];
  let total = 0, nulls = 0, refusals = 0;
  for (const [pw, extra] of PLAIN) for (const [aw, over] of [...NON_BUILTIN, ...BUILTIN]) for (const [ww, who] of [...ADMINS, ...MEMBERS]) {
    total++;
    const a = app({ ...over, manifest: raw(extra) });
    const cm = m(extra);
    const got = serverDeployDenial(a, who, cm);
    const want = editDenial(a, who, cm);
    if (want === null) nulls++; else refusals++;
    if (got !== want) bad.push(`${pw} · ${aw} · ${ww}: serverDeployDenial=${show(got)} · editDenial=${show(want)}`);
  }
  reportBad(bad, total);
  assert.ok(nulls > 0 && refusals > 0, `조합이 «된다 · 안 된다» 를 다 덮어야 뜻이 있다 — null ${nulls} · 거절 ${refusals}`);
});

test("S3 종전 규칙 그대로(대표 경우) — 전원 · 지정 명단 · 명단 빔 · 나만 보는 앱 · 책임자", () => {
  const ok = m();
  assert.equal(serverDeployDenial(app({ edit_mode: "all" }), bob, ok), null, "전원 — 아무 구성원이나");

  const carolOnly = app({ edit_mode: "members", edit_members: ["carol"] });
  assert.equal(serverDeployDenial(carolOnly, carol, ok), null, "명단 안은 된다");
  assert.equal(serverDeployDenial(carolOnly, admin, ok), null, "관리자는 명단 밖이어도 된다");
  assert.ok(isRefusal(serverDeployDenial(carolOnly, bob, ok)), "명단 밖 일반 구성원은 안 된다");

  const empty = app({ edit_mode: "members", edit_members: [] });
  assert.ok(isRefusal(serverDeployDenial(empty, bob, ok)), "명단 빔 — 일반은 안 된다");
  assert.equal(serverDeployDenial(empty, admin, ok), null, "명단 빔 — 관리자는 된다");

  const mine = app({ visibility: "me", owner_member: "alice", made_by: "alice" });
  assert.equal(serverDeployDenial(mine, alice, ok), null, "나만 보는 앱 — 책임자는 된다");
  assert.ok(isRefusal(serverDeployDenial(mine, bob, ok)), "나만 보는 앱 — 남은 안 된다");
  assert.equal(serverDeployDenial(mine, admin, ok), null, "나만 보는 앱 — 관리자는 된다");

  const ownerEmpty = app({ edit_mode: "members", edit_members: [], owner_member: "alice" });
  assert.equal(serverDeployDenial(ownerEmpty, alice, ok), null, "책임자는 명단 밖이어도 된다");
  assert.ok(isRefusal(serverDeployDenial(ownerEmpty, bob, ok)), "책임자 규칙이 남에게 문을 넓히지 않는다");
});

// ── S4 ────────────────────────────────────────────────────────────────────────

test("S4 빌트인 앱 · 확장 기능 있음 → 관리자라도 editDenial 과 같은 거절(«릴리스로만»)", () => {
  const bad: string[] = [];
  let total = 0;
  for (const [ew, extra] of EXT) for (const [aw, over] of BUILTIN) for (const [ww, who] of ADMINS) {
    total++;
    expectSameRefusal(bad, `${ew} · ${aw} · ${ww}`, app({ ...over, manifest: raw(extra) }), who, m(extra));
  }
  reportBad(bad, total);
});

test("S4 빌트인 앱 · 확장 기능 있음 · 관리자 아님 → editDenial 과 같은 거절", () => {
  const bad: string[] = [];
  let total = 0;
  for (const [ew, extra] of EXT) for (const [aw, over] of BUILTIN) for (const [ww, who] of MEMBERS) {
    total++;
    expectSameRefusal(bad, `${ew} · ${aw} · ${ww}`, app({ ...over, manifest: raw(extra) }), who, m(extra));
  }
  reportBad(bad, total);
});

test("S4 같은 확장 앱 · 같은 관리자 — 빌트인만 바꾸면 결과가 갈린다(빌트인 아님 → null · 빌트인 → editDenial 의 거절)", () => {
  const picks: Array<[string, Record<string, unknown>]> = [
    ["에이전트 정기 작업", { jobs: [headlessJob] }],
    ["서버 정기 작업", { web: { server: true }, jobs: [serverJob] }],
    ["system(셸 렌더러)", { system: { renderer: "browser" } }],
  ];
  for (const [ew, extra] of picks) {
    const cm = m(extra);
    assert.equal(serverDeployDenial(app({ manifest: raw(extra) }), admin, cm), null, `${ew}: 빌트인 아님 → null`);
    const b = app({ manifest: raw(extra), source: { kind: "builtin" }, builtin_version: "1.0.0" });
    const got = serverDeployDenial(b, admin, cm);
    assert.ok(isRefusal(got), `${ew}: 빌트인 → 거절 — ${show(got)}`);
    assert.equal(got, editDenial(b, admin, cm), `${ew}: 빌트인 거절은 editDenial 과 같은 문자열`);
  }
});

// ── S5 ────────────────────────────────────────────────────────────────────────

const ROW_MANIFESTS: Array<[string, unknown]> = [
  ["행 manifest: 정기 작업", raw({ jobs: [headlessJob] })],
  ["행 manifest: 서버 앱", raw(serverApp)],
  ["행 manifest: 화면 · 표만", base],
];

test("S5 currentManifest 를 못 읽음(null) → 관리자라도 editDenial 과 같은 거절 — 앱 행의 manifest 칸에 확장 기능이 있든 없든 · 빌트인이든 아니든", () => {
  const bad: string[] = [];
  let total = 0;
  for (const [rw, rowManifest] of ROW_MANIFESTS) for (const [aw, over] of [...NON_BUILTIN, ...BUILTIN]) for (const [ww, who] of ADMINS) {
    total++;
    expectSameRefusal(bad, `${rw} · ${aw} · ${ww}`, app({ ...over, manifest: rowManifest }), who, null);
  }
  reportBad(bad, total);
});

test("S5 currentManifest 가 null · 관리자 아님 → editDenial 과 같은 거절", () => {
  const bad: string[] = [];
  let total = 0;
  for (const [rw, rowManifest] of ROW_MANIFESTS) for (const [aw, over] of [...NON_BUILTIN, ...BUILTIN]) for (const [ww, who] of MEMBERS) {
    total++;
    expectSameRefusal(bad, `${rw} · ${aw} · ${ww}`, app({ ...over, manifest: rowManifest }), who, null);
  }
  reportBad(bad, total);
});
