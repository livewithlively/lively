// 묶음 형식 v1 — 앞머리 왕복, 묶음 쓰기·읽기, 무결성, 판 번호, 잠긴 묶음, 망가진 항목.
//  실행: npx tsx --test src/transfer/bundle.test.ts   (사양: #5458 spec 표 C)
//
//  ── 엣지 표 ──────────────────────────────────────────────────────────────
//   C1  본문에 \n---\n · 맨 앞 --- · 유니코드 · 빈 본문(폴더)       → 그대로 왕복
//   C2  앞머리 없음 · 닫히지 않음 · 값이 JSON 아님 · 키 이름 이상    → 형식 오류
//   C3  묶음 쓰기 → 읽기                                       → 지식·분류·자료·만든 곳 그대로, 지문 일치
//   C4  목록에 있는 파일 내용이 바뀜                             → 거절
//   C5  목록에 있는 파일이 없음                                 → 거절
//   C6  판 번호 > 지원 판 / = 지원 판                           → 거절 / 허용
//   C7  형식 이름이 다름 · manifest 없음                        → 거절
//   C8  만든 워크스페이스 id 가 비었음                           → 거절
//   C9  잠긴 묶음 + 비밀번호 없음 / 있음                         → password_required / 읽힘
//   C10 지식 파일 하나가 망가짐                                 → 그 항목만 문제 목록
//   C11 같은 원래 이름이 두 번                                  → 뒤의 것만 문제 목록
//   C12 내용 지문 — 필드 키 순서만 다름 / 본문 한 글자 다름        → 같다 / 다르다
//   C13 목록에 없는 여분 파일                                   → 읽지 않는다
//   C14 대소문자만 다른 두 이름                                 → 파일 경로가 대소문자 없이도 겹치지 않고, 둘 다 읽힌다(stage 실측)
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  knowledgeToMarkdown, parseFrontMatter, writeBundleZip, readBundle, bundleContentHash, sha256Hex,
  BundleFormatError, BundlePasswordRequiredError, BUNDLE_VERSION, BUNDLE_FORMAT,
  type BundleKnowledge, type BundleManifest,
} from "./bundle.js";
import { readZip, writeZip } from "./zip.js";
import { sealBundle } from "./seal.js";

function k(over: Partial<BundleKnowledge> = {}): BundleKnowledge {
  return {
    ref: "doc-a", title: "문서 A", body_md: "본문", type: "reference", category: "eng", lifecycle: "active",
    provenance: "authored", injection: "recalled", confidence: "human", summary: null, is_wiki: false, searchable: true,
    is_folder: false, parent: null, sort: 0, visibility: "open", supersedes: null, fields: {}, external_system: null,
    external_url: null, links: [], sources: [], updated_at: "2026-11-09T00:00:00.000Z", version: 3, ...over,
  };
}

const manifestBase = (over: Partial<BundleManifest> = {}): Omit<BundleManifest, "files" | "counts"> => ({
  format: BUNDLE_FORMAT, version: BUNDLE_VERSION, created_at: "2026-11-09T00:00:00.000Z",
  origin: { workspace_uid: "uid-source", name: "보내는 곳", gateway_url: "https://a.example", core_version: "v1" },
  exported_by: "admin",
  selection: { all: false, categories: ["eng"], knowledge: 0, include_sources: true, include_archived: false },
  ...over,
});

/** zip 안 한 파일을 바꿔 끼운 새 zip(나머지는 그대로) */
function replaceEntry(zip: Buffer, path: string, data: Buffer | null): Buffer {
  const files = readZip(zip);
  if (data) files.set(path, data); else files.delete(path);
  return writeZip([...files.entries()].map(([p, d]) => ({ path: p, data: d })));
}

test("C1 앞머리 왕복 — 본문 속 ---, 맨 앞 ---, 유니코드, 빈 본문이 그대로", () => {
  const bodies = ["앞\n---\n뒤\n---\n", "---\n맨 앞이 구분선", "이모지 🎉 · 한글 · \"따옴표\" · \\역슬래시", ""];
  for (const body of bodies) {
    const src = k({ body_md: body, is_folder: body === "", fields: { "원본 주소": "https://x", n: 1, o: { a: [1, 2] } }, links: [{ to: "b", relation: "refines" }] });
    const { meta, body: back } = parseFrontMatter(knowledgeToMarkdown(src));
    assert.equal(back, body, JSON.stringify(body));
    assert.equal(meta.ref, "doc-a");
    assert.deepEqual(meta.fields, src.fields);
    assert.deepEqual(meta.links, src.links);
  }
});

test("C2 앞머리 형식이 어긋나면 형식 오류", () => {
  for (const bad of [
    "그냥 글",                        // 앞머리 없음
    "---\nref: \"a\"\n본문",          // 닫히지 않음
    "---\nref: a\n---\n본문",         // 값이 JSON 아님
    "---\nRef-Name: \"a\"\n---\n",    // 키 이름 이상
  ]) {
    assert.throws(() => parseFrontMatter(bad), BundleFormatError, bad);
  }
});

test("C3 묶음 쓰기 → 읽기가 그대로 돌아오고 목록 지문이 맞다", async () => {
  const knowledge = [k(), k({ ref: "folder-1", title: "폴더", body_md: "", is_folder: true }), k({ ref: "doc-b", parent: "folder-1", sources: [{ ref: "7", relation: "cites" }] })];
  const categories = [{ key: "eng", name: "엔지니어링", description: "설명", should: "정의", cross_cutting: false }];
  const sources = [{ ref: "7", kind: "slack", title: "스레드", body_md: "원문", fields: { channel: "c" }, provenance: "observed", visibility: "open",
    external_system: "slack", external_instance: "T1", external_id: "123.4", external_url: null, parent_external_id: null, occurred_at: null, author: "a" }];
  const { zip, manifest } = writeBundleZip({ manifest: manifestBase(), knowledge, categories, sources });
  assert.deepEqual(manifest.counts, { knowledge: 3, categories: 1, sources: 1 });
  const files = readZip(zip);
  for (const [p, m] of Object.entries(manifest.files)) assert.equal(sha256Hex(files.get(p)!), m.sha256, p);
  const { bundle, problems, sealed } = await readBundle(zip);
  assert.equal(sealed, false);
  assert.deepEqual(problems, []);
  assert.deepEqual(bundle.knowledge.map((x) => x.ref).sort(), ["doc-a", "doc-b", "folder-1"]);
  assert.deepEqual(bundle.knowledge.find((x) => x.ref === "doc-b"), knowledge[2]);
  assert.deepEqual(bundle.categories, categories);
  assert.deepEqual(bundle.sources, sources);
  assert.equal(bundle.manifest.origin.workspace_uid, "uid-source");
});

test("C4 목록에 있는 파일 내용이 바뀌면 거절한다", async () => {
  const { zip } = writeBundleZip({ manifest: manifestBase(), knowledge: [k()], categories: [], sources: [] });
  const tampered = replaceEntry(zip, "knowledge/doc-a.md", Buffer.from(knowledgeToMarkdown(k({ body_md: "몰래 바꾼 본문" }))));
  await assert.rejects(readBundle(tampered), BundleFormatError);
});

test("C5 목록에 있는 파일이 없으면 거절한다", async () => {
  const { zip } = writeBundleZip({ manifest: manifestBase(), knowledge: [k()], categories: [], sources: [] });
  await assert.rejects(readBundle(replaceEntry(zip, "knowledge/doc-a.md", null)), BundleFormatError);
});

test("C6 판 번호가 지원 판보다 크면 거절, 같으면 허용한다", async () => {
  const { zip } = writeBundleZip({ manifest: manifestBase(), knowledge: [k()], categories: [], sources: [] });
  const m = JSON.parse(readZip(zip).get("manifest.json")!.toString()) as BundleManifest;
  const newer = replaceEntry(zip, "manifest.json", Buffer.from(JSON.stringify({ ...m, version: BUNDLE_VERSION + 1 })));
  await assert.rejects(readBundle(newer), /더 새 라이블리/);
  const same = replaceEntry(zip, "manifest.json", Buffer.from(JSON.stringify({ ...m, version: BUNDLE_VERSION })));
  assert.equal((await readBundle(same)).bundle.knowledge.length, 1);
});

test("C7 형식 이름이 다르거나 manifest 가 없으면 거절한다", async () => {
  const { zip } = writeBundleZip({ manifest: manifestBase(), knowledge: [k()], categories: [], sources: [] });
  const m = JSON.parse(readZip(zip).get("manifest.json")!.toString()) as BundleManifest;
  await assert.rejects(readBundle(replaceEntry(zip, "manifest.json", Buffer.from(JSON.stringify({ ...m, format: "other" })))), BundleFormatError);
  await assert.rejects(readBundle(replaceEntry(zip, "manifest.json", null)), BundleFormatError);
});

test("C8 만든 워크스페이스 id 가 비었으면 거절한다", async () => {
  const { zip } = writeBundleZip({ manifest: manifestBase({ origin: { workspace_uid: "", name: null, gateway_url: null, core_version: null } }), knowledge: [k()], categories: [], sources: [] });
  await assert.rejects(readBundle(zip), BundleFormatError);
});

test("C9 잠긴 묶음은 비밀번호가 없으면 password_required, 있으면 읽힌다", async () => {
  const { zip } = writeBundleZip({ manifest: manifestBase(), knowledge: [k()], categories: [], sources: [] });
  const sealed = await sealBundle(zip, "비밀번호-12345");
  await assert.rejects(readBundle(sealed), (e: unknown) => e instanceof BundlePasswordRequiredError && e.code === "password_required");
  const r = await readBundle(sealed, "비밀번호-12345");
  assert.equal(r.sealed, true);
  assert.equal(r.bundle.knowledge[0].ref, "doc-a");
  assert.ok(r.zip.equals(zip), "적용 때 다시 읽을 잠금 푼 zip 을 돌려준다");
});

test("C10 지식 파일 하나가 망가지면 그 항목만 문제 목록에 오르고 나머지는 읽힌다", async () => {
  const good = Buffer.from(knowledgeToMarkdown(k({ ref: "good" })));
  const broken = Buffer.from("---\ntitle: \"ref 없음\"\n---\n본문");
  const files = [{ path: "knowledge/good.md", data: good }, { path: "knowledge/broken.md", data: broken }];
  const manifest = { ...manifestBase(), counts: { knowledge: 2, categories: 0, sources: 0 },
    files: Object.fromEntries(files.map((f) => [f.path, { sha256: sha256Hex(f.data), bytes: f.data.length }])) };
  const zip = writeZip([{ path: "manifest.json", data: Buffer.from(JSON.stringify(manifest)) }, ...files]);
  const { bundle, problems } = await readBundle(zip);
  assert.deepEqual(bundle.knowledge.map((x) => x.ref), ["good"]);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].path, "knowledge/broken.md");
});

test("C11 같은 원래 이름이 두 번 들어 있으면 뒤의 것만 문제 목록에 오른다", async () => {
  const a = Buffer.from(knowledgeToMarkdown(k({ ref: "dup", title: "첫째" })));
  const b = Buffer.from(knowledgeToMarkdown(k({ ref: "dup", title: "둘째" })));
  const files = [{ path: "knowledge/dup-1.md", data: a }, { path: "knowledge/dup-2.md", data: b }];
  const manifest = { ...manifestBase(), counts: { knowledge: 2, categories: 0, sources: 0 },
    files: Object.fromEntries(files.map((f) => [f.path, { sha256: sha256Hex(f.data), bytes: f.data.length }])) };
  const zip = writeZip([{ path: "manifest.json", data: Buffer.from(JSON.stringify(manifest)) }, ...files]);
  const { bundle, problems } = await readBundle(zip);
  assert.equal(bundle.knowledge.length, 1);
  assert.equal(bundle.knowledge[0].title, "첫째");
  assert.equal(problems.length, 1);
});

test("C12 내용 지문 — 필드 키 순서만 다르면 같고, 본문 한 글자가 다르면 다르다", () => {
  const h1 = bundleContentHash(k({ fields: { a: 1, b: { x: 1, y: 2 } } }));
  const h2 = bundleContentHash(k({ fields: { b: { y: 2, x: 1 }, a: 1 } }));
  assert.equal(h1, h2);
  assert.notEqual(bundleContentHash(k({ body_md: "본문" })), bundleContentHash(k({ body_md: "본문." })));
});

test("C13 목록에 없는 여분 파일은 읽지 않는다", async () => {
  const { zip } = writeBundleZip({ manifest: manifestBase(), knowledge: [k()], categories: [], sources: [] });
  const extra = replaceEntry(zip, "knowledge/sneaky.md", Buffer.from(knowledgeToMarkdown(k({ ref: "sneaky" }))));
  const { bundle } = await readBundle(extra);
  assert.deepEqual(bundle.knowledge.map((x) => x.ref), ["doc-a"]);
});

test("C14 대소문자만 다른 두 이름은 파일 경로가 대소문자 없이도 겹치지 않고 둘 다 읽힌다", async () => {
  const { zip } = writeBundleZip({ manifest: manifestBase(), knowledge: [k({ ref: "2026-06-11-PM툴" }), k({ ref: "2026-06-11-pm툴" })], categories: [], sources: [] });
  const paths = [...readZip(zip).keys()].filter((p) => p.startsWith("knowledge/"));
  assert.equal(paths.length, 2);
  assert.equal(new Set(paths.map((p) => p.toLowerCase())).size, 2, JSON.stringify(paths));
  const { bundle } = await readBundle(zip);
  assert.deepEqual(bundle.knowledge.map((x) => x.ref).sort(), ["2026-06-11-PM툴", "2026-06-11-pm툴"]);
});
