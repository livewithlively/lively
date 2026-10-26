// Zotero 커넥터 단위 — DB·네트워크 불요(전역 fetch 를 가짜 Zotero 로 바꾼다).
// 실행: npm run build && node dist/connectors/zotero.test.js
//
//  이 테스트가 지키는 것: ① 주석은 논문이 아니라 PDF 첨부에 달린다(주석 → 첨부 → 논문) — 묶기가 틀리면 하이라이트가
//  조용히 사라진다. ② 증분 run 은 바뀐 주석 하나로 그 논문 전체를 다시 묶어야 한다(주석만 따로 오면 뜻이 없다).
//  ③ 개인 라이브러리 자료만 주인에게 잠긴다. ④ 증류 사전필터 표지(머리)는 주석·노트가 있을 때만 달린다.
import assert from "node:assert/strict";
import {
  parseLibraryList, parseCollectionKeys, expandCollections, colorName, noteHtmlToText, creatorsLine, yearOf,
  annotationLine, buildPaperDoc, paperToItem, zoteroItemUrl, zoteroItems, ANNOTATION_HEAD, NOTE_HEAD, type ZItem,
} from "./zotero.js";
import { routeIngestV6 } from "../org/ingest/ingest-classify.js";
import { sourceKindOf } from "../v6/mirror/mirror-source.js";
import { SOURCE_KINDS } from "../capabilities/source.js";
import { diagnoseZotero, zoteroCaveat } from "../org/credentials/credential-verify.js";
import type { RawItem } from "./types.js";

let pass = 0;
const tests: Array<[string, () => void | Promise<void>]> = [];
const t = (name: string, fn: () => void | Promise<void>): void => { tests.push([name, fn]); };

// ── 순수 함수 ─────────────────────────────────────────────────────────────────
t("parseLibraryList: users/·groups/·그룹 주소·me 를 알아보고, 같은 것은 한 번만 · 모르는 것은 unknown", () => {
  const r = parseLibraryList("users/7 groups/9 https://www.zotero.org/groups/9/lab/library me group:3", "7");
  assert.deepEqual(r.libs, [{ kind: "users", id: "7" }, { kind: "groups", id: "9" }]);
  assert.deepEqual(r.unknown, ["group:3"]);
  assert.deepEqual(parseLibraryList("me").unknown, ["me"], "userId 를 모르면 me 를 풀 수 없다");
  assert.deepEqual(parseLibraryList("").libs, []);
});

t("parseCollectionKeys: 8자 key 와 컬렉션 주소를 받고 대문자로 맞춘다", () => {
  assert.deepEqual(parseCollectionKeys("abcd1234 https://www.zotero.org/u7/collections/QWER5678/items x"), ["ABCD1234", "QWER5678"]);
  assert.deepEqual(parseCollectionKeys("short TOOLONGKEY1"), []);
});

t("expandCollections: 부모를 고르면 하위까지 · 이 라이브러리에 없는 key 는 무시", () => {
  const all = [{ key: "C1", parentCollection: false as const }, { key: "C2", parentCollection: "C1" }, { key: "C3", parentCollection: "C2" }, { key: "C9" }];
  assert.deepEqual([...expandCollections(["C1"], all)].sort(), ["C1", "C2", "C3"]);
  assert.deepEqual([...expandCollections(["ZZ"], all)], []);
});

t("colorName·noteHtmlToText·creatorsLine·yearOf", () => {
  assert.equal(colorName("#FFD400"), "노랑");
  assert.equal(colorName("#123456"), "#123456", "모르는 색은 값 그대로(뜻을 지어내지 않는다)");
  assert.equal(noteHtmlToText("<h1>요약</h1><p>첫 줄&nbsp;&amp; 둘</p><ul><li>가</li><li>나</li></ul>x<br>y &#44277;"), "요약\n첫 줄 & 둘\n\n- 가\n- 나\nx\ny 공");
  assert.equal(creatorsLine([{ lastName: "Kim", firstName: "A" }, { name: "WHO" }, { lastName: "Lee" }, { lastName: "Park" }, { lastName: "X", creatorType: "translator" }]),
    "A Kim, WHO, Lee 외 1명");
  assert.equal(yearOf("2023-05-01"), "2023");
  assert.equal(yearOf("Spring 1998"), "1998");
  assert.equal(yearOf(""), "");
  assert.equal(noteHtmlToText("a &#99999999; b &#xD800; c"), "a &#99999999; b &#xD800; c", "범위 밖 엔티티가 던지면 노트 하나가 수집 전체를 세운다");
});

const ann = (key: string, parent: string, d: Partial<ZItem["data"]>, who?: string): ZItem =>
  ({ key, meta: who ? { createdByUser: { id: 1, name: who } } : {}, data: { key, itemType: "annotation", parentItem: parent, ...d } });

t("annotationLine: 원문·색·페이지·코멘트 · 글 없는 그림 주석은 null · 그룹이면 이름", () => {
  assert.equal(annotationLine(ann("A", "F", { annotationType: "highlight", annotationText: "핵심  문장", annotationColor: "#ffd400", annotationPageLabel: "3", annotationComment: "동의" }), false),
    "- p.3 [노랑] «핵심 문장» — 코멘트: 동의");
  assert.equal(annotationLine(ann("A", "F", { annotationType: "note", annotationComment: "여기 다시" }), false), "- 메모 코멘트: 여기 다시");
  assert.equal(annotationLine(ann("A", "F", { annotationType: "image" }), false), null);
  assert.equal(annotationLine(ann("A", "F", { annotationType: "highlight", annotationText: "t", annotationPageLabel: "-" }), false), "- «t»", "쪽 이름 «-» 는 쪽이 아니다");
  assert.equal(annotationLine(ann("A", "F", { annotationType: "underline", annotationText: "u" }, "Kim"), true), "- 밑줄 «u» (Kim)");
});

const paper: ZItem = { key: "P1", data: { key: "P1", itemType: "journalArticle", title: "Paper", abstractNote: "초록", date: "2021",
  creators: [{ lastName: "Kim" }], publicationTitle: "Nature", DOI: "10.1/x", dateModified: "2026-01-01T00:00:00Z",
  tags: [{ tag: "핵심" }, { tag: "MeSH:Auto", type: 1 }] } };
const pdf: ZItem = { key: "F1", data: { key: "F1", itemType: "attachment", contentType: "application/pdf", parentItem: "P1", title: "PDF" } };
const opts = { includeAnnotations: true, includeNotes: true, includeAutoTags: false };
const ctx = { libraryName: "내 라이브러리", collectionNames: ["리뷰"], group: false };

t("buildPaperDoc: 생각이 있을 때만 머리가 붙고, 자동 태그는 빠지고, 수정 시각은 가장 늦은 자식", () => {
  const a1 = ann("A1", "F1", { annotationType: "highlight", annotationText: "h", dateModified: "2026-03-01T00:00:00Z", annotationSortIndex: "00001" });
  const a2 = ann("A2", "F1", { annotationType: "image", dateModified: "2026-02-01T00:00:00Z" });
  const note: ZItem = { key: "N1", data: { key: "N1", itemType: "note", parentItem: "P1", note: "<p>내 생각</p>", dateModified: "2026-02-15T00:00:00Z" } };
  const doc = buildPaperDoc(paper, { notes: [note], attachments: [{ item: pdf, annotations: [a1, a2] }] }, opts, ctx);
  assert.match(doc.body, /^# Paper\nKim · 2021 · Nature\nDOI: 10\.1\/x/);
  assert.ok(doc.body.includes("컬렉션: 리뷰") && doc.body.includes("태그: 핵심") && !doc.body.includes("MeSH"));
  assert.ok(doc.body.includes(`${ANNOTATION_HEAD} (1)`) && doc.body.includes(`${NOTE_HEAD} (1)`));
  assert.ok(doc.body.includes("그림·손글씨 주석 1개는 뺐습니다"));
  assert.equal(doc.updatedAt, "2026-03-01T00:00:00.000Z");
  assert.equal(doc.annotationCount, 1);
  const bare = buildPaperDoc(paper, { notes: [], attachments: [] }, opts, ctx);
  assert.ok(!bare.body.includes(ANNOTATION_HEAD) && !bare.body.includes(NOTE_HEAD), "서지만 있는 논문에 머리가 붙었다 — 사전필터를 지난다");
  const off = buildPaperDoc(paper, { notes: [note], attachments: [{ item: pdf, annotations: [a1] }] }, { ...opts, includeAnnotations: false, includeNotes: false }, ctx);
  assert.ok(!off.body.includes(ANNOTATION_HEAD) && !off.body.includes(NOTE_HEAD), "끈 종류가 본문에 남았다");
  assert.equal(off.updatedAt, "2026-03-01T00:00:00.000Z", "꺼 둔 주석이 바뀌어도 수정 시각이 따라와야 커서가 멈추지 않는다");
});

t("paperToItem: 자료로 간다 · kind=zotero_item · 개인만 주인에게 잠긴다 · instance 없이 같은 외부 좌표", () => {
  const lib = { kind: "users" as const, id: "7" };
  const it = paperToItem(paper, { notes: [], attachments: [] }, opts, { lib, libraryName: "내 라이브러리", collectionNames: [], username: "u7", owner: "m1" });
  assert.equal(routeIngestV6(it.type, "zotero"), "source");
  assert.equal(sourceKindOf("zotero"), "zotero_item");
  assert.ok((SOURCE_KINDS as readonly string[]).includes("zotero_item"));
  assert.equal(it.provenance.external_id, "users/7:P1");
  assert.equal(it.provenance.instance, undefined);
  assert.equal(it.provenance.external_url, "https://www.zotero.org/u7/items/P1");
  assert.deepEqual(it.audience, ["m1"]);
  assert.equal(it.fields?.has_thinking, false);
  const g = paperToItem(paper, { notes: [], attachments: [] }, opts, { lib: { kind: "groups", id: "9" }, libraryName: "Lab", collectionNames: [], owner: undefined });
  assert.equal(g.audience, undefined, "그룹 라이브러리 자료를 한 사람에게 잠갔다");
  assert.equal(zoteroItemUrl({ kind: "users", id: "7" }, "P1"), undefined, "사용자 이름을 모르면 주소를 짓지 않는다");
});

t("자격 확인: 403 은 키 거부 · 노트 권한이 꺼지면 알려 준다 · 둘 다 켜졌으면 말이 없다", () => {
  assert.match(diagnoseZotero(403, "Forbidden"), /거부/);
  assert.match(String(zoteroCaveat({ access: { user: { library: true, notes: false } } })), /notes access/);
  assert.match(String(zoteroCaveat({ access: {} })), /읽을 수 있는 라이브러리가 없어요/);
  assert.equal(zoteroCaveat({ access: { user: { library: true, notes: true } } }), null);
  assert.equal(zoteroCaveat({ access: { groups: { all: { library: true } } } }), null, "그룹만 연 키는 노트 칸을 묻지 않는다");
});

// ── 가짜 Zotero 로 full·증분 묶기 ────────────────────────────────────────────────
interface Lib { items: ZItem[]; collections: Array<{ key: string; data: { name: string; parentCollection?: string | false } }> }
function fakeZotero(libs: Record<string, Lib>, key: { userID: number; username: string; access: unknown }, opts: { deny?: boolean; groupStatus?: number } = {}) {
  const calls: string[] = [];
  const json = (body: unknown, total?: number): Response => new Response(JSON.stringify(body),
    { status: 200, headers: total != null ? { "Total-Results": String(total) } : {} });
  const page = <T>(all: T[], u: URL): Response => {
    const start = Number(u.searchParams.get("start") ?? 0), limit = Number(u.searchParams.get("limit") ?? 25);
    return json(all.slice(start, start + limit), all.length);
  };
  const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
    const u = new URL(String(input));
    calls.push(u.pathname + u.search);
    if (opts.deny) return new Response("Forbidden", { status: 403 });
    if (u.pathname === "/keys/current") return json(key);
    if (u.pathname === "/users/7/groups") return page([{ id: 9, data: { name: "Lab" } }], u);
    if (opts.groupStatus && u.pathname.startsWith("/groups/9/")) return new Response("down", { status: opts.groupStatus });
    const m = u.pathname.match(/^\/(users|groups)\/(\d+)\/(.*)$/);
    const lib = m ? libs[`${m[1]}/${m[2]}`] : undefined;
    if (!m || !lib) return new Response("Not found", { status: 404 });
    const rest = m[3];
    if (rest === "collections") return page(lib.collections, u);
    if (rest === "items") {
      const keys = u.searchParams.get("itemKey");
      if (keys) return json(lib.items.filter((i) => keys.split(",").includes(i.key)));
      let all = [...lib.items];
      if (u.searchParams.get("sort") === "dateModified") {
        all.sort((a, b) => String(b.data.dateModified).localeCompare(String(a.data.dateModified)));
      }
      all = all.filter(Boolean);
      return page(all, u);
    }
    const c = rest.match(/^items\/([A-Z0-9]+)\/children$/);
    if (c) return page(lib.items.filter((i) => i.data.parentItem === c[1]), u);
    const f = rest.match(/^items\/([A-Z0-9]+)\/fulltext$/);
    if (f) return f[1] === "F1" ? json({ content: "본문 전문", indexedPages: 1, totalPages: 1 }) : new Response("", { status: 404 });
    return new Response("Not found", { status: 404 });
  };
  return { fetchImpl, calls };
}

const T0 = "2026-01-01T00:00:00Z";
const item = (key: string, d: Partial<ZItem["data"]>, who?: string): ZItem =>
  ({ key, meta: who ? { createdByUser: { id: 3, username: who.toLowerCase(), name: who } } : {}, data: { key, itemType: "journalArticle", dateModified: T0, dateAdded: T0, ...d } });

function library(): Record<string, Lib> {
  return {
    "users/7": {
      collections: [{ key: "C1AAAAAA", data: { name: "리뷰", parentCollection: false } }, { key: "C2AAAAAA", data: { name: "리뷰-하위", parentCollection: "C1AAAAAA" } },
        { key: "C3AAAAAA", data: { name: "개인", parentCollection: false } }],
      items: [
        item("P1", { title: "주석 있는 논문", collections: ["C1AAAAAA"] }),
        item("F1", { itemType: "attachment", parentItem: "P1", contentType: "application/pdf", title: "PDF" }),
        item("A1", { itemType: "annotation", parentItem: "F1", annotationType: "highlight", annotationText: "핵심", annotationColor: "#ffd400" }),
        item("N1", { itemType: "note", parentItem: "P1", note: "<p>내 판단</p>" }),
        item("P2", { title: "서지만", itemType: "book" }),
        item("P3", { title: "하위 컬렉션 논문", collections: ["C2AAAAAA"] }),
        item("P4", { title: "개인 자료", collections: ["C3AAAAAA"] }),
        item("S1", { itemType: "note", note: "<p>독립 노트</p>" }),
        item("F2", { itemType: "attachment", contentType: "application/pdf", title: "끌어다 놓은 PDF" }),
        item("A3", { itemType: "annotation", parentItem: "F2", annotationType: "highlight", annotationText: "부모 없는 PDF 의 주석" }),
      ],
    },
    "groups/9": {
      collections: [],
      items: [
        item("G1", { title: "연구실 논문" }, "Kim"),
        item("GF", { itemType: "attachment", parentItem: "G1", contentType: "application/pdf" }, "Kim"),
        item("GA", { itemType: "annotation", parentItem: "GF", annotationType: "highlight", annotationText: "그룹 하이라이트" }, "Lee"),
      ],
    },
  };
}
const KEY = { userID: 7, username: "u7", access: { user: { library: true, notes: true }, groups: { all: { library: true } } } };

//  토글이 만든 수집기는 늘 token_source=member:<켠 사람> 이다 — 기본으로 그렇게 두고, 주인 없는 경우만 따로 본다.
async function run(libs: Record<string, Lib>, cfg: Record<string, string | undefined>, since?: string, o: { deny?: boolean; groupStatus?: number } = {}) {
  const fz = fakeZotero(libs, KEY, o);
  const orig = globalThis.fetch;
  globalThis.fetch = fz.fetchImpl as typeof fetch;
  const out: RawItem[] = [];
  try {
    for await (const it of zoteroItems("KEY", { token_source: "member:m1", ...cfg }, since)) out.push(it);
    return { out, calls: fz.calls, error: null as Error | null };
  } catch (e) {
    return { out, calls: fz.calls, error: e as Error };
  } finally { globalThis.fetch = orig; }
}
const ids = (xs: RawItem[]): string[] => xs.map((x) => x.provenance.external_id).sort();

t("★ full: 논문마다 주석(첨부 아래)·노트가 묶이고, 독립 노트·부모 없는 PDF 도 한 건 · 개인만 잠긴다", async () => {
  const { out } = await run(library(), { token_source: "member:m1" });
  assert.deepEqual(ids(out), ["groups/9:G1", "users/7:F2", "users/7:P1", "users/7:P2", "users/7:P3", "users/7:P4", "users/7:S1"]);
  const p1 = out.find((x) => x.provenance.external_id === "users/7:P1")!;
  assert.ok(p1.body!.includes("«핵심»") && p1.body!.includes("내 판단") && p1.body!.includes("컬렉션: 리뷰"));
  assert.equal(p1.fields?.has_thinking, true);
  assert.deepEqual(p1.audience, ["m1"]);
  assert.ok(out.find((x) => x.provenance.external_id === "users/7:F2")!.body!.includes("부모 없는 PDF 의 주석"));
  assert.ok(out.find((x) => x.provenance.external_id === "users/7:S1")!.body!.includes(NOTE_HEAD));
  const g1 = out.find((x) => x.provenance.external_id === "groups/9:G1")!;
  assert.ok(g1.body!.includes("그룹 하이라이트") && g1.body!.includes("(Lee)") && g1.body!.includes("추가한 사람: Kim"));
  assert.equal(g1.audience, undefined);
  assert.equal(g1.container_name, "Lab");
});

t("★ 컬렉션을 고르면 그 컬렉션(하위 포함)만 — 컬렉션이 없는 라이브러리는 라이브러리 칸에 적었을 때만 통째로", async () => {
  assert.deepEqual(ids((await run(library(), { collections: "C1AAAAAA" })).out), ["users/7:P1", "users/7:P3"]);
  assert.deepEqual(ids((await run(library(), { collections: "C1AAAAAA", libraries: "users/7 groups/9" })).out), ["groups/9:G1", "users/7:P1", "users/7:P3"]);
});

t("★ 고른 컬렉션을 어디서도 못 찾으면(오타·지운 컬렉션) 개인 라이브러리를 통째로 열지 않고 실패한다", async () => {
  const r = await run(library(), { collections: "ZZZZZZZZ" });
  assert.deepEqual(ids(r.out), [], "오타 하나로 라이브러리 전체가 들어왔다");
  assert.match(String(r.error?.message), /찾지 못했습니다/);
});

t("★ 라이브러리 하나가 실패하면 나머지는 받되 run 은 실패한다(커서 동결) · 그룹이 사라진 것(404)은 건너뛴다", async () => {
  const bad = await run(library(), {}, undefined, { groupStatus: 500 });
  assert.ok(ids(bad.out).includes("users/7:P1"), "멀쩡한 라이브러리까지 멈췄다");
  assert.match(String(bad.error?.message), /다 읽지 못했습니다/, "실패를 삼켜 커서가 전진한다");
  const gone = await run(library(), {}, undefined, { groupStatus: 404 });
  assert.equal(gone.error, null, "나간 그룹이 매 run 실패를 만든다");
});

t("주인을 모르는 수집기(키를 직접 붙인 것)는 개인 라이브러리를 건너뛴다 — 잠글 사람을 모르면 열지 않는다", async () => {
  const r = await run(library(), { token_source: undefined, token: "KEY" });
  assert.deepEqual(ids(r.out), ["groups/9:G1"]);
});

t("라이브러리를 고르면 그것만 · 노트를 끄면 독립 노트가 빠지고 논문 본문에 노트 머리가 없다", async () => {
  assert.deepEqual(ids((await run(library(), { libraries: "groups/9" })).out), ["groups/9:G1"]);
  const { out } = await run(library(), { libraries: "users/7", include_notes: "off" });
  assert.ok(!ids(out).includes("users/7:S1"));
  assert.ok(!out.find((x) => x.provenance.external_id === "users/7:P1")!.body!.includes(NOTE_HEAD));
});

t("★ 증분: 주석 하나가 바뀌면 그 논문 한 편만 다시 묶여 오고, updated_at 이 그 주석의 수정 시각이다", async () => {
  const libs = library();
  const LATER = "2026-05-05T05:05:05Z";
  const a1 = libs["users/7"].items.find((i) => i.key === "A1")!;
  a1.data.dateModified = LATER;
  a1.data.annotationComment = "새 코멘트";
  const { out, calls } = await run(libs, {}, "2026-02-01T00:00:00Z");
  assert.deepEqual(ids(out), ["users/7:P1"]);   // T0(1/1)은 창(2/1 − 3일) 밖이라 다시 안 온다
  assert.equal(out[0].updated_at, new Date(LATER).toISOString());
  assert.ok(out[0].body!.includes("새 코멘트") && out[0].body!.includes("내 판단"), "다시 묶을 때 논문의 나머지(노트)가 빠졌다");
  assert.ok(!calls.some((c) => /\/items\?limit=/.test(c) && !c.includes("sort=")), "증분인데 라이브러리를 통째로 받았다");
});

t("증분 창은 3일 뒤로 넓다(오프라인 편집이 늦게 동기화돼도 잡는다) · 미래 시각은 커서에 지금으로 깎인다", async () => {
  const libs = library();
  libs["users/7"].items.find((i) => i.key === "P2")!.data.dateModified = "2026-01-30T00:00:00Z";   // 커서(2/1)보다 이틀 앞
  libs["users/7"].items.find((i) => i.key === "P3")!.data.dateModified = "2099-01-01T00:00:00Z";   // 시계가 틀린 클라이언트
  const { out } = await run(libs, {}, "2026-02-01T00:00:00Z");
  assert.deepEqual(ids(out), ["users/7:P2", "users/7:P3"]);
  assert.ok(Date.parse(String(out.find((x) => x.provenance.external_id === "users/7:P3")!.updated_at)) <= Date.now(), "미래 시각이 커서를 밀었다");
});

t("전문은 켤 때만 — 기본은 받지 않는다", async () => {
  const off = await run(library(), { libraries: "users/7" });
  assert.ok(!off.calls.some((c) => c.endsWith("/fulltext")));
  const on = await run(library(), { libraries: "users/7", include_fulltext: "on" });
  assert.ok(on.out.find((x) => x.provenance.external_id === "users/7:P1")!.body!.includes("본문 전문"));
});

t("키가 거부되면(403) 사람 말로 멈춘다 — 0건으로 조용히 끝나지 않는다", async () => {
  assert.match(String((await run(library(), {}, undefined, { deny: true })).error?.message), /API 키를 거부/);
});

for (const [name, fn] of tests) { await fn(); pass++; console.log(`ok  ${name}`); }
console.log(`\nzotero connector tests: ${pass} passed`);
