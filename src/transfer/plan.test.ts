// 가져오기 판정·이름 예약·분류 맞추기·결정 해소·[[링크]] 고쳐 쓰기 — 순수 함수라 받는 쪽 상태를 손으로 만들어 넣는다.
//  실행: npx tsx --test src/transfer/plan.test.ts   (사양: #5458 spec 표 D)
//
//  ── 엣지 표 (행마다 테스트 하나) ──────────────────────────────────────────
//   D1  처음 보고 이름 빔                       → new / 새로 만들기, 원래 이름
//   D2  처음 보는데 같은 이름 있음                → name_taken / 새 이름(x-2), 덮어쓰기·건너뛰기 가능
//   D2b 같은 이름 문서가 외부 미러                → 덮어쓰기 불가
//   D3  전에 가져옴, 둘 다 그대로                 → 건너뛰기
//   D4  원본만 바뀜                             → 갱신
//   D5  여기만 바뀜                             → 건너뛰기
//   D6  둘 다 바뀜                              → 건너뛰기, 덮어쓰기·둘 다 남기기 가능
//   D7  여기서 지움                             → 건너뛰기, 다시 만들기 가능(원래 여기 이름)
//   D8  모르는 종류·상태 · 빈 본문 · 제목 없는 폴더  → invalid / 건너뛰기
//   D9  받는 쪽 x, 묶음 x 와 x-2                 → x-2 는 자기 이름, x 는 다른 새 이름
//   D10 묶음 안 슬러그가 같은 둘                  → 이름이 다르다
//   D11 64자 이름이 겹침                         → 새 이름도 64자 이하
//   D12 분류 6가지                              → same_key · same_name · before · create · -2 · 분류 없음 한 줄
//   D13 같은 워크스페이스에서 내보낸 파일          → 거절
//   D14 대상자 제한·위키 핀·외부 미러             → 전체 안내 + 항목 안내
//   D15 결정 — 허용 / 허용 밖 / 없음              → 반영 / 기본값 / 기본값
//   D16 없는 분류로 맞추라는 결정                 → 거절
//   D17 새로 만들 분류 key 가 활성/비활성으로 있음  → 그대로 쓴다 / -2
//   D18 이름 대응                               → 새 이름 / 여기 이름 / 없음
//   D19 [[링크]] 고쳐 쓰기                       → 바뀐 것만, 라벨·앵커 보존, 코드 안 그대로, 슬러그 링크도
//   D20 자료 — 전에 가져옴·같은 외부 원본·새것      → 이미 있음 2 · 새것 1
//   D21 지식 0건 묶음                           → 합계 0
import { test } from "node:test";
import assert from "node:assert/strict";
import { bundleContentHash, BUNDLE_FORMAT, BUNDLE_VERSION, type Bundle, type BundleKnowledge, type BundleSource } from "./bundle.js";
import {
  planImport, resolveDecisions, rewriteWikiLinks, targetContentHash, PlanError, UNSORTED,
  type TargetState, type TargetKnowledge, type PlanKnowledgeItem,
} from "./plan.js";

function k(ref: string, over: Partial<BundleKnowledge> = {}): BundleKnowledge {
  return {
    ref, title: `제목 ${ref}`, body_md: `본문 ${ref}`, type: "reference", category: "eng", lifecycle: "active",
    provenance: "authored", injection: "recalled", confidence: "human", summary: null, is_wiki: false, searchable: true,
    is_folder: false, parent: null, sort: 0, visibility: "open", supersedes: null, fields: {}, external_system: null,
    external_url: null, links: [], sources: [], updated_at: null, version: 1, ...over,
  };
}
function bundleOf(knowledge: BundleKnowledge[], extra: Partial<Bundle> = {}, uid = "uid-src"): Bundle {
  return {
    manifest: {
      format: BUNDLE_FORMAT, version: BUNDLE_VERSION, created_at: "2026-11-09T00:00:00.000Z",
      origin: { workspace_uid: uid, name: "보내는 곳", gateway_url: null, core_version: null }, exported_by: "admin",
      counts: { knowledge: knowledge.length, categories: 0, sources: 0 },
      selection: { all: false, categories: [], knowledge: 0, include_sources: false, include_archived: false }, files: {},
    },
    knowledge, categories: [{ key: "eng", name: "엔지니어링", description: null, should: null, cross_cutting: false }], sources: [], ...extra,
  };
}
function local(name: string, over: Partial<TargetKnowledge> = {}): TargetKnowledge {
  return { name, title: `제목 ${name}`, body_md: `여기 본문 ${name}`, type: "reference", category: "eng", summary: null, is_folder: false, parent_name: null, fields: {}, provenance: "authored", ...over };
}
function target(over: Partial<TargetState> = {}): TargetState {
  return {
    workspaceUid: "uid-dst", names: new Set(), knowledge: new Map(),
    categories: [{ key: "eng", name: "엔지니어링", state: "active" }],
    originsKnowledge: new Map(), originsCategory: new Map(), originsSource: new Map(), sourceIds: new Set(), sourcesByExternal: new Map(),
    ...over,
  };
}
const item = (plan: { knowledge: PlanKnowledgeItem[] }, ref: string): PlanKnowledgeItem => {
  const it = plan.knowledge.find((x) => x.ref === ref);
  assert.ok(it, `계획에 ${ref} 가 있어야 한다`);
  return it;
};

test("D1 처음 보고 이름이 비어 있으면 원래 이름으로 새로 만든다", () => {
  const p = planImport(bundleOf([k("a")]), target());
  const it = item(p, "a");
  assert.equal(it.status, "new");
  assert.equal(it.action, "create");
  assert.equal(it.new_name, "a");
  assert.deepEqual(it.actions, ["create", "skip"]);
});

test("D2 처음 보는데 같은 이름이 있으면 기본은 새 이름으로 따로 만든다", () => {
  const p = planImport(bundleOf([k("b")]), target({ names: new Set(["b"]), knowledge: new Map([["b", local("b")]]) }));
  const it = item(p, "b");
  assert.equal(it.status, "name_taken");
  assert.equal(it.existing, "b");
  assert.equal(it.action, "rename");
  assert.equal(it.new_name, "b-2");
  assert.deepEqual([...it.actions].sort(), ["overwrite", "rename", "skip"]);
});

test("D2b 같은 이름 문서가 외부 미러면 덮어쓰기를 고를 수 없다", () => {
  const p = planImport(bundleOf([k("b")]), target({ names: new Set(["b"]), knowledge: new Map([["b", local("b", { provenance: "observed" })]]) }));
  assert.ok(!item(p, "b").actions.includes("overwrite"));
});

function lineageCase(over: { srcChanged: boolean; localChanged: boolean }) {
  const kb = k("c");
  const lc = local("c-here");
  const lineage = { local_ref: "c-here", origin_hash: over.srcChanged ? "old-origin" : bundleContentHash(kb), local_hash: over.localChanged ? "old-local" : targetContentHash(lc) };
  return item(planImport(bundleOf([kb]), target({ names: new Set(["c-here"]), knowledge: new Map([["c-here", lc]]), originsKnowledge: new Map([["c", lineage]]) })), "c");
}

test("D3 전에 가져왔고 양쪽 다 그대로면 건너뛴다", () => {
  const it = lineageCase({ srcChanged: false, localChanged: false });
  assert.equal(it.status, "reimport_unchanged");
  assert.equal(it.action, "skip");
  assert.equal(it.existing, "c-here");
});

test("D4 원본만 바뀌었으면 갱신한다", () => {
  const it = lineageCase({ srcChanged: true, localChanged: false });
  assert.equal(it.status, "reimport_update");
  assert.equal(it.action, "update");
});

test("D5 여기만 바뀌었으면 건너뛴다(여기 수정 보존)", () => {
  const it = lineageCase({ srcChanged: false, localChanged: true });
  assert.equal(it.status, "reimport_local_changed");
  assert.equal(it.action, "skip");
});

test("D6 양쪽 다 바뀌었으면 건너뛰고, 덮어쓰기·둘 다 남기기를 고를 수 있다", () => {
  const it = lineageCase({ srcChanged: true, localChanged: true });
  assert.equal(it.status, "reimport_conflict");
  assert.equal(it.action, "skip");
  assert.ok(it.actions.includes("update") && it.actions.includes("rename"));
  assert.notEqual(it.new_name, "c-here", "둘 다 남기기용 이름은 여기 문서와 겹치지 않는다");
});

test("D7 여기서 지운 문서면 건너뛰고, 다시 만들기는 원래 여기 이름으로", () => {
  const p = planImport(bundleOf([k("g")]), target({ originsKnowledge: new Map([["g", { local_ref: "g-here", origin_hash: "x", local_hash: "y" }]]) }));
  const it = item(p, "g");
  assert.equal(it.status, "reimport_deleted");
  assert.equal(it.action, "skip");
  assert.ok(it.actions.includes("create"));
  assert.equal(it.new_name, "g-here");
});

test("D8 받는 쪽이 모르는 값·빈 본문·제목 없는 폴더는 invalid 로 건너뛴다", () => {
  const p = planImport(bundleOf([
    k("t", { type: "playbook" }),
    k("l", { lifecycle: "frozen" }),
    k("e", { body_md: "   " }),
    k("f", { is_folder: true, title: null, body_md: "" }),
    k("ok-folder", { is_folder: true, title: "폴더", body_md: "" }),
  ]), target());
  for (const ref of ["t", "l", "e", "f"]) {
    const it = item(p, ref);
    assert.equal(it.status, "invalid", ref);
    assert.equal(it.action, "skip", ref);
    assert.ok(it.reason, ref);
  }
  assert.equal(item(p, "ok-folder").status, "new");
  assert.equal(p.summary.invalid, 4);
});

test("D9 겹친 지식의 새 이름이 묶음 안 다른 지식의 원래 이름을 빼앗지 않는다", () => {
  const p = planImport(bundleOf([k("x"), k("x-2")]), target({ names: new Set(["x"]), knowledge: new Map([["x", local("x")]]) }));
  assert.equal(item(p, "x-2").status, "new");
  assert.equal(item(p, "x-2").new_name, "x-2");
  assert.equal(item(p, "x").status, "name_taken");
  assert.ok(!["x", "x-2"].includes(item(p, "x").new_name));
});

test("D10 묶음 안에서 슬러그가 같은 둘은 서로 다른 이름으로 들어간다", () => {
  const p = planImport(bundleOf([k("Same-Name"), k("same-name")]), target());
  const names = p.knowledge.map((x) => x.new_name);
  assert.equal(new Set(names).size, 2);
  assert.ok(names.includes("same-name"));
});

test("D11 64자 이름이 겹쳐도 새 이름은 64자 이하다", () => {
  const long = "a".repeat(64);
  const p = planImport(bundleOf([k(long)]), target({ names: new Set([long]), knowledge: new Map([[long, local(long)]]) }));
  const it = item(p, long);
  assert.ok(it.new_name.length <= 64, it.new_name);
  assert.notEqual(it.new_name, long);
});

test("D12 분류 맞추기 제안 — 같은 key · 같은 이름 · 전에 맞춤 · 새로 · 비활성 key · 분류 없음", () => {
  const b = bundleOf([
    k("k1", { category: "eng" }), k("k2", { category: "design" }), k("k3", { category: "legacy" }),
    k("k4", { category: "newcat" }), k("k5", { category: "ops" }), k("k6", { category: null }),
  ], { categories: [
    { key: "eng", name: "엔지니어링", description: null, should: null, cross_cutting: false },
    { key: "design", name: "디자인", description: null, should: null, cross_cutting: false },
    { key: "legacy", name: "옛 분류", description: null, should: null, cross_cutting: false },
    { key: "newcat", name: "새 분류", description: null, should: "정의", cross_cutting: false },
    { key: "ops", name: "운영", description: null, should: null, cross_cutting: false },
  ] });
  const t = target({
    categories: [
      { key: "eng", name: "Engineering", state: "active" }, { key: "d-1", name: "디자인", state: "active" },
      { key: "eng2", name: "엔지니어링2", state: "active" }, { key: "ops", name: "운영", state: "deprecated" },
    ],
    originsCategory: new Map([["legacy", { local_ref: "eng2" }]]),
  });
  const p = planImport(b, t);
  const s = new Map(p.categories.map((c) => [c.ref, c.suggestion]));
  assert.deepEqual(s.get("eng"), { action: "map", to: "eng", why: "same_key" });
  assert.deepEqual(s.get("design"), { action: "map", to: "d-1", why: "same_name" });
  assert.deepEqual(s.get("legacy"), { action: "map", to: "eng2", why: "before" });
  assert.deepEqual(s.get("newcat"), { action: "create", key: "newcat", name: "새 분류" });
  assert.deepEqual(s.get("ops"), { action: "create", key: "ops-2", name: "운영" });
  assert.deepEqual(s.get(UNSORTED.ref), { action: "create", key: UNSORTED.key, name: UNSORTED.name });
  assert.equal(p.categories.find((c) => c.ref === "eng")?.count, 1);
});

test("D13 같은 워크스페이스에서 내보낸 파일은 거절한다", () => {
  assert.throws(() => planImport(bundleOf([k("a")], {}, "same"), target({ workspaceUid: "same" })), PlanError);
});

test("D14 대상자 제한·위키 핀·외부 미러 지식은 전체 안내와 항목 안내가 붙는다", () => {
  const p = planImport(bundleOf([
    k("r", { visibility: "members" }), k("w", { is_wiki: true }), k("o", { provenance: "observed", external_system: "notion", external_url: "https://n" }),
  ]), target());
  const all = p.notes.join("\n");
  assert.match(all, /공개로/);
  assert.match(all, /핀 없이/);
  assert.match(all, /일반 지식/);
  assert.ok(item(p, "r").notes.some((n) => /공개로/.test(n)));
  assert.ok(item(p, "w").notes.some((n) => /핀 없이/.test(n)));
  assert.ok(item(p, "o").notes.some((n) => /일반 지식/.test(n)));
  assert.equal(item(p, "r").status, "new", "안내가 붙어도 들이는 판정은 그대로다");
});

test("D15 결정 — 허용된 것은 반영, 허용 밖·없음은 기본값", () => {
  const b = bundleOf([k("n1"), k("n2"), k("n3")]);
  const t = target();
  const p = planImport(b, t);
  const r = resolveDecisions(p, { knowledge: { n1: "skip", n2: "overwrite" } }, t, b.categories);
  const f = new Map(r.items.map((x) => [x.ref, x.final]));
  assert.equal(f.get("n1"), "skip");
  assert.equal(f.get("n2"), "create", "새 문서에 덮어쓰기는 허용 밖 → 기본값");
  assert.equal(f.get("n3"), "create");
});

test("D16 받는 쪽에 없는 분류로 맞추라는 결정은 거절한다", () => {
  const b = bundleOf([k("a")]);
  const t = target();
  const p = planImport(b, t);
  assert.throws(() => resolveDecisions(p, { categories: { eng: { action: "map", to: "nope" } } }, t, b.categories), PlanError);
});

test("D17 새로 만들 분류 key 가 활성으로 있으면 그대로 쓰고, 비활성으로 있으면 -2 로 만든다", () => {
  const b = bundleOf([k("a", { category: "x" }), k("b", { category: "y" })], { categories: [] });
  const t = target({ categories: [{ key: "eng", name: "엔지니어링", state: "active" }, { key: "old", name: "옛", state: "deprecated" }] });
  const p = planImport(b, t);
  const r = resolveDecisions(p, { categories: { x: { action: "create", key: "eng" }, y: { action: "create", key: "old" } } }, t, b.categories);
  assert.equal(r.categoryMap.get("x"), "eng");
  assert.equal(r.categoryMap.get("y"), "old-2");
  assert.deepEqual(r.createCategories.map((c) => c.key), ["old-2"]);
  assert.equal(r.items.find((i) => i.ref === "b")?.target_category, "old-2");
});

test("D18 이름 대응 — 새 이름으로 / 건너뛰었지만 전에 가져옴 / 건너뛰고 기록도 없음", () => {
  const kc = k("c");
  const lc = local("c-here");
  const b = bundleOf([k("b"), kc, k("z")]);
  const t = target({
    names: new Set(["b", "c-here"]), knowledge: new Map([["b", local("b")], ["c-here", lc]]),
    originsKnowledge: new Map([["c", { local_ref: "c-here", origin_hash: bundleContentHash(kc), local_hash: targetContentHash(lc) }]]),
  });
  const p = planImport(b, t);
  const r = resolveDecisions(p, { knowledge: { z: "skip" } }, t, b.categories);
  assert.equal(r.nameMap.get("b"), "b-2");
  assert.equal(r.nameMap.get("c"), "c-here");
  assert.equal(r.nameMap.has("z"), false);
});

test("D19 [[링크]] 고쳐 쓰기 — 바뀐 이름만, 라벨·앵커 보존, 코드 안은 그대로, 슬러그 링크도", () => {
  const map = new Map([["b", "b-2"], ["c", "c"]]);
  const body = [
    "앞 [[b]] 와 [[b|비 문서]] 와 [[b#절]] 그리고 [[c]] 와 [[모르는것]]",
    "슬러그로 쓴 [[B]]",
    "인라인 `[[b]]` 는 예시",
    "```",
    "[[b]] 코드 안",
    "```",
  ].join("\n");
  const out = rewriteWikiLinks(body, map).split("\n");
  assert.equal(out[0], "앞 [[b-2]] 와 [[b-2|비 문서]] 와 [[b-2#절]] 그리고 [[c]] 와 [[모르는것]]");
  assert.equal(out[1], "슬러그로 쓴 [[b-2]]");
  assert.equal(out[2], "인라인 `[[b]]` 는 예시");
  assert.equal(out[4], "[[b]] 코드 안");
  assert.equal(rewriteWikiLinks(body, new Map()), body);
});

test("D20 자료 — 전에 가져와 아직 있음 · 같은 외부 원본 있음은 이미 있음, 나머지는 새것", () => {
  const s = (ref: string, ext: string | null): BundleSource => ({ ref, kind: "slack", title: null, body_md: "", fields: {}, provenance: "observed", visibility: "open",
    external_system: ext ? "slack" : null, external_instance: ext ? "T" : null, external_id: ext, external_url: null, parent_external_id: null, occurred_at: null, author: null });
  const b = bundleOf([k("a")], { sources: [s("1", null), s("2", "ts-2"), s("3", null), s("4", null)] });
  const t = target({
    originsSource: new Map([["1", { local_ref: "50" }], ["4", { local_ref: "99" }]]),
    sourceIds: new Set([50]), // 99 는 여기서 지워졌다
    sourcesByExternal: new Map([["slack\u0001T\u0001ts-2", 70]]),
  });
  assert.deepEqual(planImport(b, t).sources, { count: 4, existing: 2, fresh: 2 });
});

test("D21 지식이 0건인 묶음도 계획은 서고 합계가 0 이다", () => {
  const p = planImport(bundleOf([]), target());
  assert.equal(p.summary.total, 0);
  assert.deepEqual(p.knowledge, []);
  assert.deepEqual(p.categories, []);
});
