// 앱 AI 작업의 도구 허용 목록(매니페스트 ai.tools) — 목록 읽기(순수) · 두 목록 합치기(순수) · «부른 사람(주소)의 판» 에서 고르기.
//  판 고르기는 진짜 규칙(visibility.appViewFor · app-view.asPublished)으로 하고 판 행만 가짜로 바꿔 끼운다 — 가짜가 규칙을 흉내 내면 규칙이 틀려도 통과한다.
//  행 번호는 사양 T3~T10(도구 허용 목록 사양). 이게 틀리면: 공개 판을 보는 사람의 작업이 초안의 목록으로(또는 그 반대로) 도구를 얻거나,
//  손상된 매니페스트가 «좁히지 않음» 으로 읽혀 앱 동의 전체(store_sql 등)가 에이전트에게 열리거나, 이어받기가 앞 대화보다 넓은 도구로 잇는다.
import assert from "node:assert/strict";
import { narrowAllowlist, resolveJobTools, toolsOf, type JobToolsDeps } from "./app-job-tools.js";
import { appViewFor, type Viewer } from "./visibility.js";
import { asPublished } from "./app-view.js";
import type { OrgApp } from "../org/store/apps.js";
import { HttpError } from "../http-error.js";

let pass = 0;
const t = async (name: string, fn: () => Promise<void> | void): Promise<void> => {
  try { await fn(); } catch (e) { console.log(`not ok  ${name}`); throw e; }
  pass++;
  console.log(`ok  ${name}`);
};

/** ai 칸을 받아 매니페스트를 만든다 — tools 를 빼거나(종전) 모양을 틀리게 둘 수 있게. */
const manifestWith = (ai: Record<string, unknown>) => ({ id: "policy", title: "정책", ai: { jobs: [{ name: "answer" }, { name: "lookup" }], ...ai } });
/** 순서와 무관하게 같은 이름들인가 — 허용 목록은 이름의 모임이다(순서를 사양이 정한 곳 — T10 — 은 따로 본다). 중복이 남으면 길이로 걸린다. */
const sameNames = (got: readonly string[] | null, want: readonly string[], msg?: string): void => {
  assert.ok(Array.isArray(got), `목록이어야 한다(null 아님): ${JSON.stringify(got)} ${msg ?? ""}`);
  assert.deepEqual([...got].sort(), [...want].sort(), msg);
};

/** 초안(설치된 상태 3)의 선언 · 공개 판(2)의 선언 — 기본은 두 판이 서로 다른 목록이라 어느 판을 읽었는지 값으로 갈린다. */
const DRAFT_DECL = { tools: { answer: ["knowledge_search"] } };
const PUB_DECL = { tools: { answer: ["store_sql"] } };

/**
 * 공개 앱 «policy» — 공개 판 2 · alice 가 고친 초안 = 설치된 상태 3.
 *  noDraft 면 걸린 초안이 없다(설치된 상태가 모두의 판 — 따로 볼 공개 판이 없다). views() = 판 고르기를 부른 횟수.
 */
function world(o: { draftAi?: Record<string, unknown>; pubAi?: Record<string, unknown>; visibility?: "all" | "me"; noDraft?: boolean } = {}) {
  let views = 0;
  const heads: Record<number, { manifest: unknown; content_hash: string }> = {
    2: { manifest: manifestWith(o.pubAi ?? PUB_DECL), content_hash: "h2" },
    3: { manifest: manifestWith(o.draftAi ?? DRAFT_DECL), content_hash: "h3" },
  };
  const app = {
    id: "policy", title: "정책", version: "0.3.0", manifest: heads[3]!.manifest, content_hash: "h3", current_version_no: 3,
    visibility: o.visibility ?? "all", owner_member: "owner", draft_by: o.noDraft ? null : "alice", published_version_no: o.noDraft ? null : 2,
    source: { kind: "inline" }, installed_at: new Date(0),
  } as unknown as OrgApp;
  const d: JobToolsDeps = {
    viewAppFor: async (a, who) => {
      views++;
      const view = appViewFor(a, who);
      if (view !== "published") return { view, app: a };
      const h = heads[a.published_version_no as number]!;
      return { view, app: asPublished(a, { version_no: a.published_version_no as number, version: "0.2.0", manifest: h.manifest, content_hash: h.content_hash }) };
    },
  };
  return { app, d, views: () => views };
}
const who = (userId: string, address?: "pub" | "draft"): Viewer => ({ userId, scopes: [], ...(address ? { address } : {}) });
const httpErr = (status: number) => (e: unknown) => e instanceof HttpError && e.status === status;

// ── T9 매니페스트 안 목록 읽기(순수) ──────────────────────────────────────────────

await t("T9 그 작업 키가 있으면 그 목록 — 다른 작업의 목록과 섞이지 않는다", () => {
  const m = manifestWith({ tools: { answer: ["store_sql", "knowledge_search"], lookup: ["knowledge_get"] } });
  sameNames(toolsOf(m, "answer"), ["store_sql", "knowledge_search"]);
  sameNames(toolsOf(m, "lookup"), ["knowledge_get"]);
});

await t("T9 중복 이름은 하나로", () => {
  sameNames(toolsOf(manifestWith({ tools: { answer: ["store_sql", "knowledge_search", "store_sql", "store_sql"] } }), "answer"), ["store_sql", "knowledge_search"]);
});

await t("T9·T4 키가 없거나 · ai.tools 가 없거나 · 매니페스트가 null 이면 null(좁히지 않음 — 종전)", () => {
  assert.equal(toolsOf(manifestWith({ tools: { lookup: ["knowledge_get"] } }), "answer"), null, "다른 작업만 목록이 있다");
  assert.equal(toolsOf(manifestWith({ tools: {} }), "answer"), null, "빈 ai.tools");
  assert.equal(toolsOf(manifestWith({}), "answer"), null, "ai.tools 없음");
  assert.equal(toolsOf({ id: "policy", title: "정책" }, "answer"), null, "ai 칸 자체가 없는 앱");
  assert.equal(toolsOf(manifestWith({ tools: { "answer-x": ["a"], answe: ["b"], ANSWER: ["c"] } }), "answer"), null, "같은 이름만 — 앞머리 · 일부 · 대소문자가 다른 키는 다른 작업");
  for (const m of [null, undefined, {}, [], "policy", 3, { ai: null }, { ai: "x" }, { ai: [] }]) {
    assert.equal(toolsOf(m, "answer"), null, `매니페스트: ${String(JSON.stringify(m))}`);
  }
});

await t("T9 객체가 물려받은 이름(constructor 등)은 작업 키가 아니다 — 목록이 없는 작업으로 읽는다(null)", () => {
  //  constructor 는 ai.jobs 의 작업 이름 꼴에 맞는 이름이다 — 목록을 두지 않은 그 작업이 «손상된 목록»(빈 목록 — 도구 0)으로 읽히면 안 된다.
  const m = manifestWith({ tools: { answer: ["store_sql"] } });
  for (const job of ["constructor", "toString", "hasOwnProperty", "valueOf"]) {
    assert.equal(toolsOf(m, job), null, job);
  }
});

await t("T9 키는 있는데 값이 배열이 아니면(손상) 빈 목록 — 아무것도 허락하지 않는다 · 던지지 않는다", () => {
  for (const bad of ["store_sql", { 0: "store_sql", length: 1 }, { store_sql: true }, 1, true, null]) {
    let got: unknown;
    assert.doesNotThrow(() => { got = toolsOf(manifestWith({ tools: { answer: bad } }), "answer"); }, JSON.stringify(bad));
    assert.deepEqual(got, [], `배열 아님: ${JSON.stringify(bad)}`);
  }
});

await t("T9 문자열이 아닌 원소가 하나라도 있으면(손상) 빈 목록 — 문자열 원소만 골라 쓰지 않는다", () => {
  for (const bad of [[1], [null], [["store_sql"]], [{ name: "store_sql" }], ["store_sql", 2], ["store_sql", null]]) {
    let got: unknown;
    assert.doesNotThrow(() => { got = toolsOf(manifestWith({ tools: { answer: bad } }), "answer"); }, JSON.stringify(bad));
    assert.deepEqual(got, [], `문자열 아닌 원소: ${JSON.stringify(bad)}`);
  }
});

await t("T3·T9 빈 배열도 목록이다 — null(좁히지 않음)이 아니라 빈 목록(도구 0)", () => {
  assert.deepEqual(toolsOf(manifestWith({ tools: { answer: [] } }), "answer"), []);
});

await t("T6 작업 이름이 없으면(빈 값 · null · undefined) null — 빈 이름의 키가 있어도", () => {
  const m = manifestWith({ tools: { "": ["store_sql"], answer: ["knowledge_search"] } });
  for (const job of ["", null, undefined]) assert.equal(toolsOf(m, job), null, String(job));
});

// ── T10 두 목록 합치기(순수 — 이어받기에 쓴다) ──────────────────────────────────

await t("T10 둘 다 있으면 겹치는 것만 — 첫째 목록의 순서", () => {
  assert.deepEqual(narrowAllowlist(["store_sql", "knowledge_get", "knowledge_search"], ["knowledge_search", "store_sql", "web_fetch"]), ["store_sql", "knowledge_search"]);
  assert.deepEqual(narrowAllowlist(["knowledge_search", "store_sql", "web_fetch"], ["store_sql", "knowledge_get", "knowledge_search"]), ["knowledge_search", "store_sql"], "순서는 첫째 목록을 따른다(둘째 목록 순서가 아니다)");
  assert.deepEqual(narrowAllowlist(["store_sql"], ["knowledge_search"]), [], "겹치는 것이 없으면 빈 목록(넓어지지 않는다)");
});

await t("T10 빈 목록과 합치면 빈 목록 — 어느 쪽이 비어도", () => {
  assert.deepEqual(narrowAllowlist([], ["store_sql"]), []);
  assert.deepEqual(narrowAllowlist(["store_sql"], []), []);
  assert.deepEqual(narrowAllowlist([], null), []);
  assert.deepEqual(narrowAllowlist(null, []), []);
  assert.deepEqual(narrowAllowlist([], []), []);
});

await t("T10 하나만 있으면 그것 · 둘 다 없으면 null", () => {
  assert.deepEqual(narrowAllowlist(["store_sql", "knowledge_search"], null), ["store_sql", "knowledge_search"]);
  assert.deepEqual(narrowAllowlist(null, ["knowledge_get"]), ["knowledge_get"]);
  assert.equal(narrowAllowlist(null, null), null);
});

await t("T10 받은 목록을 고치지 않는다(얼린 목록으로 불러도 된다)", () => {
  const a = Object.freeze(["store_sql", "knowledge_search"]), b = Object.freeze(["knowledge_search"]);
  assert.deepEqual(narrowAllowlist(a, b), ["knowledge_search"]);
  assert.deepEqual([...a], ["store_sql", "knowledge_search"]);
  assert.deepEqual([...b], ["knowledge_search"]);
});

// ── T5~T8 «부른 사람(주소)의 판» 에서 고르기 ────────────────────────────────────

await t("T5 두 판이 다른 목록 — 초안을 고친 사람은 설치된 상태(초안) · 다른 사람은 공개 판 · 앱 주소면 그 주소의 판", async () => {
  const { app, d } = world();
  sameNames(await resolveJobTools(app, who("alice"), "answer", d), ["knowledge_search"], "초안을 고친 사람");
  sameNames(await resolveJobTools(app, who("bob"), "answer", d), ["store_sql"], "다른 사람");
  sameNames(await resolveJobTools(app, who("alice", "pub"), "answer", d), ["store_sql"], "공개 주소는 공개 판 — 초안을 고친 사람도");
  sameNames(await resolveJobTools(app, who("alice", "draft"), "answer", d), ["knowledge_search"], "초안 주소는 설치된 상태");
  sameNames(await resolveJobTools(app, who("bob", "pub"), "answer", d), ["store_sql"]);
});

await t("T5 초안만 목록을 둠 — 초안을 고친 사람은 그 목록 · 다른 사람(공개 판)은 null · 공개 주소면 고친 사람도 null", async () => {
  const { app, d } = world({ pubAi: {} });
  sameNames(await resolveJobTools(app, who("alice"), "answer", d), ["knowledge_search"]);
  assert.equal(await resolveJobTools(app, who("bob"), "answer", d), null);
  assert.equal(await resolveJobTools(app, who("alice", "pub"), "answer", d), null);
  sameNames(await resolveJobTools(app, who("alice", "draft"), "answer", d), ["knowledge_search"]);
});

await t("T5 공개 판만 목록을 둠 — 설치된 매니페스트에 목록이 없어도 걸린 초안이 있으면 다른 사람은 공개 판의 목록", async () => {
  const { app, d } = world({ draftAi: {} });
  sameNames(await resolveJobTools(app, who("bob"), "answer", d), ["store_sql"]);
  sameNames(await resolveJobTools(app, who("bob", "pub"), "answer", d), ["store_sql"]);
  assert.equal(await resolveJobTools(app, who("alice"), "answer", d), null);
  assert.equal(await resolveJobTools(app, who("alice", "draft"), "answer", d), null);
  sameNames(await resolveJobTools(app, who("alice", "pub"), "answer", d), ["store_sql"]);
});

await t("T5 작업마다 그 판의 목록으로 — 초안은 lookup · 공개 판은 answer 만 목록을 둠", async () => {
  const { app, d } = world({ draftAi: { tools: { lookup: ["knowledge_get"] } }, pubAi: { tools: { answer: ["store_sql"] } } });
  sameNames(await resolveJobTools(app, who("alice"), "lookup", d), ["knowledge_get"]);
  assert.equal(await resolveJobTools(app, who("alice"), "answer", d), null);
  assert.equal(await resolveJobTools(app, who("bob"), "lookup", d), null);
  sameNames(await resolveJobTools(app, who("bob"), "answer", d), ["store_sql"]);
});

await t("T3·T5 그 판의 빈 목록은 빈 목록(도구 0) — null 로 바뀌지 않는다", async () => {
  const { app, d } = world({ pubAi: { tools: { answer: [] } } });
  assert.deepEqual(await resolveJobTools(app, who("bob"), "answer", d), []);
  sameNames(await resolveJobTools(app, who("alice"), "answer", d), ["knowledge_search"]);
});

await t("T6 작업 이름이 없으면(빈 값 · null · undefined) null — 초안을 고친 사람 · 공개 판을 보는 사람 모두", async () => {
  for (const job of ["", null, undefined]) {
    const { app, d } = world({ draftAi: { tools: { "": ["store_sql"], answer: ["knowledge_search"] } }, pubAi: { tools: { "": ["store_sql"] } } });
    assert.equal(await resolveJobTools(app, who("alice"), job, d), null, `초안을 고친 사람: ${String(job)}`);
    assert.equal(await resolveJobTools(app, who("bob"), job, d), null, `공개 판을 보는 사람: ${String(job)}`);
  }
});

await t("T7 그 사람이 앱을 볼 수 없으면 404 — 나만 보는 앱의 남 · 남의 초안 주소", async () => {
  const me = world({ visibility: "me", noDraft: true });
  await assert.rejects(resolveJobTools(me.app, who("bob"), "answer", me.d), httpErr(404));
  sameNames(await resolveJobTools(me.app, who("owner"), "answer", me.d), ["knowledge_search"], "책임자는 설치된 상태를 본다");
  const all = world();
  await assert.rejects(resolveJobTools(all.app, who("bob", "draft"), "answer", all.d), httpErr(404), "남의 초안 주소는 볼 수 없는 판");
});

await t("T8 설치된 매니페스트에 그 작업의 목록이 없고 걸린 초안도 없으면 — 판을 읽지 않고 null", async () => {
  for (const ai of [{}, { tools: {} }, { tools: { lookup: ["knowledge_get"] } }]) {
    const { app, d, views } = world({ draftAi: ai, noDraft: true });
    assert.equal(await resolveJobTools(app, who("bob"), "answer", d), null, JSON.stringify(ai));
    assert.equal(views(), 0, `판을 읽지 않는다: ${JSON.stringify(ai)}`);
  }
  //  목록이 있으면 null 이 아니다 — 위의 null 이 «무엇이든 null» 이 아님을 보인다. 빈 목록 · 손상된 목록도 «목록이 있다»(T3 · T9).
  const declared = world({ noDraft: true });
  sameNames(await resolveJobTools(declared.app, who("bob"), "answer", declared.d), ["knowledge_search"]);
  const empty = world({ draftAi: { tools: { answer: [] } }, noDraft: true });
  assert.deepEqual(await resolveJobTools(empty.app, who("bob"), "answer", empty.d), []);
  const broken = world({ draftAi: { tools: { answer: "store_sql" } }, noDraft: true });
  assert.deepEqual(await resolveJobTools(broken.app, who("bob"), "answer", broken.d), [], "손상된 목록은 빈 목록(아무것도 허락하지 않음)");
});

await t("T9 ai.tools 자체가 객체가 아니면(이 칸이 생기기 전 passthrough 로 저장된 다른 뜻의 값) 선언 없음 — 작업 하나의 목록이 틀린 것(빈 목록)과 다르다", () => {
  for (const tools of ["x", ["answer"], 3, null]) assert.equal(toolsOf({ ai: { jobs: [{ name: "answer" }], tools } }, "answer"), null, JSON.stringify(tools));
  assert.deepEqual(toolsOf({ ai: { tools: { answer: "x" } } }, "answer"), [], "작업의 목록이 틀리면 닫는다");
  assert.equal(toolsOf({ ai: { tools: ["a"] } }, "0"), null, "배열의 자리 «0» 을 작업 이름으로 읽지 않는다");
});

console.log(`# ${pass} pass`);
