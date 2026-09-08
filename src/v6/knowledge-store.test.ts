// knowledge-store 순수함수 단위 체크(resolveUpsertFacets · resolveWikiLinkTargets · appendBody/isDuplicateAppend) — DB 불요. 테스트 러너 없이 node:assert 로 자급.
// 실행: npm run build && node dist/v6/knowledge-store.test.js
//
// 프로젝트 #345 회귀 방지 — knowledge_save(upsertKnowledge)가 기존 지식 '본문만' 편집할 때 미전송 facet
//  (특히 WIKI 핀 is_wiki)을 조용히 리셋하지 않는지 잠근다. 원 증상: 핀된 지식(런북·불변식 등) 본문을 누가
//  편집하면 is_wiki 가 false 로 떨어져 매 세션 WIKI 인덱스에서 소리없이 빠짐 → 발견·소환 트리거 상실.
//  불변식: "명시(undefined 아님) 우선 → 없으면 기존(before) 보존 → 신규(before=null)면 기본값".
import assert from "node:assert/strict";
import {
  resolveUpsertFacets, resolveWikiLinkTargets, appendBody, isDuplicateAppend, knowledgeListFilter,
  applyKnowledgeEdits,
  listWikiPins, type KnowledgeFilter, type KnowledgeRow,
} from "./knowledge-store.js";

let pass = 0;
const t = (name: string, fn: () => void): void => {
  fn();
  pass++;
  console.log(`ok  ${name}`);
};

// 핀된 기존 지식(before) — 본문만 편집(facet 전부 미전송)하는 저장을 흉내내는 스냅샷.
const pinned = { injection: "recalled", provenance: "authored", summary: "요약", sort: 5, is_wiki: true, type: "how-to" };

// ── #345 핵심: is_wiki 미전송 → 기존(true) 보존. 본문 편집이 WIKI 핀을 리셋하면 안 된다. ──
t("#345: 본문만 편집(is_wiki 미전송) → 핀(is_wiki=true) 보존", () => {
  assert.equal(resolveUpsertFacets({}, pinned).isWiki, true, "핀이 유실되면 안 됨");
});

// ── 같은 클래스의 조용한 유실 방지 — 나머지 facet 도 미전송 시 기존 보존. ──
t("본문만 편집 → injection/provenance/summary/sort/type 모두 기존 보존", () => {
  const r = resolveUpsertFacets({}, pinned);
  assert.equal(r.injection, "recalled");
  assert.equal(r.provenance, "authored");
  assert.equal(r.summary, "요약");
  assert.equal(r.sort, 5);
  assert.equal(r.type, "how-to");
});

// ── 명시값은 기존을 덮어쓴다(의도적 변경 존중). ──
t("is_wiki=false 명시 → 덮어쓰기(핀 해제 의도 존중)", () => {
  assert.equal(resolveUpsertFacets({ is_wiki: false }, pinned).isWiki, false);
});
t("injection/type 명시 → 덮어쓰기", () => {
  const r = resolveUpsertFacets({ injection: "always", type: "reference" }, pinned);
  assert.equal(r.injection, "always");
  assert.equal(r.type, "reference");
});

// ── 신규(before=null) → 기본값. ──
t("신규(before=null): is_wiki false, injection recalled, provenance authored, summary null, sort 0, type null", () => {
  const r = resolveUpsertFacets({}, null);
  assert.equal(r.isWiki, false);
  assert.equal(r.injection, "recalled");
  assert.equal(r.provenance, "authored");
  assert.equal(r.summary, null);
  assert.equal(r.sort, 0);
  assert.equal(r.type, null);
});

// ── 경계: null/0 '명시'는 undefined(미전송)와 구분되어 그대로 적용된다. ──
t("summary=null 명시 → null 로 덮어씀(미전송 보존과 구분)", () => {
  assert.equal(resolveUpsertFacets({ summary: null }, pinned).summary, null);
});
t("sort=0 명시 → 0 적용(기존 5 로 되돌아가지 않음)", () => {
  assert.equal(resolveUpsertFacets({ sort: 0 }, pinned).sort, 0);
});

// ── before 가 부분적(is_wiki 없음)이면 기본값으로 폴백. ──
t("before 에 is_wiki 없음 → 기본 false 폴백", () => {
  assert.equal(resolveUpsertFacets({}, { injection: "recalled" }).isWiki, false);
});

// ── #592: is_folder·parent_name 도 같은 불변식 — 본문만 편집(미전송)해도 폴더 플래그·트리 위치 유실 금지. ──
const folder = { ...pinned, is_folder: true, parent_name: "parent-doc" };
t("#592: 본문만 편집(is_folder/parent_name 미전송) → 폴더 플래그·트리 위치 보존", () => {
  const r = resolveUpsertFacets({}, folder);
  assert.equal(r.isFolder, true, "폴더가 문서로 리셋되면 안 됨");
  assert.equal(r.parentName, "parent-doc", "트리에서 떨어져 나가면 안 됨");
});
t("#592: is_folder=false·parent_name=null 명시 → 덮어쓰기(의도 존중)", () => {
  const r = resolveUpsertFacets({ is_folder: false, parent_name: null }, folder);
  assert.equal(r.isFolder, false);
  assert.equal(r.parentName, null);
});
t("#592: 신규(before=null) → is_folder false·parent_name null 기본값", () => {
  const r = resolveUpsertFacets({}, null);
  assert.equal(r.isFolder, false);
  assert.equal(r.parentName, null);
});

// ── #907 본문 [[…]] → 엣지 해소. 아래 케이스는 전부 실 DB 에서 관측된 것이다(설계 근거 = 실측). ──
//  불변식: "exact(작성자가 쓴 그대로) 우선 → slugify 폴백 → 없으면 미매칭 경고(저장은 성공)".
const K = (...names: string[]): ReadonlySet<string> => new Set(names);

t("#907: 정확한 name 은 그대로 해소", () => {
  assert.deepEqual(resolveWikiLinkTargets("from", ["alpha"], K("alpha", "beta")),
    { linked: ["alpha"], unmatched: [] });
});
t("#907: 미매칭은 경고로 — 예외 아님(붕 뜬 링크 알림)", () => {
  assert.deepEqual(resolveWikiLinkTargets("from", ["nope"], K("alpha")),
    { linked: [], unmatched: ["nope"] });
});
t("#907: 표기가 흐트러지면 slugify 폴백('Some Title' → some-title)", () => {
  assert.deepEqual(resolveWikiLinkTargets("from", ["Some Title"], K("some-title")),
    { linked: ["some-title"], unmatched: [] });
});
// ⚠ 회귀 방지 — slugify 가 strip→slice(64) 순서라 64자 절단 이름은 '-' 로 끝날 수 있다(실재: '작업-activity-…-폐기-',
//  '배포-장애-수정-…-고객사 A-'). 재슬러그화를 먼저 하면 꼬리 '-' 가 떨어져 **정확히 쓴 링크가 미매칭**된다.
t("#907: 이름이 '-' 로 끝나는 실재 지식 — exact 우선이라 해소된다", () => {
  const real = "배포-장애-수정-고객사 A-";
  assert.deepEqual(resolveWikiLinkTargets("from", [real], K(real)),
    { linked: [real], unmatched: [] });
});
// ⚠ 회귀 방지 — 대소문자만 다른 동명 지식이 실재한다(2026-06-11-PM툴… / …-pm툴…, 같은 제목·둘 다 active).
//  정규화를 먼저 태우면 작성자가 지목한 문서가 아닌 쪽에 엣지가 붙는다.
t("#907: 대소문자 쌍둥이가 둘 다 있으면 exact(작성자 의도) 를 고른다", () => {
  const upper = "2026-06-11-PM툴-설계결정", lower = "2026-06-11-pm툴-설계결정";
  assert.deepEqual(resolveWikiLinkTargets("from", [upper], K(upper, lower)),
    { linked: [upper], unmatched: [] });
});
t("#907: exact 가 없으면 slugify 로 대소문자 쌍둥이의 소문자 쪽에 붙는다", () => {
  const lower = "2026-06-11-pm툴-설계결정";
  assert.deepEqual(resolveWikiLinkTargets("from", ["2026-06-11-PM툴-설계결정"], K(lower)),
    { linked: [lower], unmatched: [] });
});
t("#907: 자기 참조는 조용히 버린다(knowledge_link_noself_chk)", () => {
  assert.deepEqual(resolveWikiLinkTargets("alpha", ["alpha"], K("alpha")),
    { linked: [], unmatched: [] });
});
t("#907: raw 와 slug 가 같은 문서로 접히면 1건(knowledge_link_uq)", () => {
  assert.deepEqual(resolveWikiLinkTargets("from", ["some-title", "Some Title"], K("some-title")),
    { linked: ["some-title"], unmatched: [] });
});
t("#907: 같은 미매칭 이름이 여러 번 나와도 경고는 1건", () => {
  assert.deepEqual(resolveWikiLinkTargets("from", ["nope", "nope"], K("alpha")),
    { linked: [], unmatched: ["nope"] });
});
t("#907: 한글 이름은 slugify 가 보존한다(wikiSlug 였다면 뭉갠다 — 71건이 걸린 갈림길)", () => {
  const ko = "런북-dev-8080-게이트웨이-빌드-재시작-context-ontology";
  assert.deepEqual(resolveWikiLinkTargets("from", [ko], K(ko)),
    { linked: [ko], unmatched: [] });
});
t("#907: pending 대상도 존재하면 링크(FK 는 존재만 요구 — '없음' 경고는 거짓말이 된다)", () => {
  assert.deepEqual(resolveWikiLinkTargets("from", ["draft"], K("draft")),
    { linked: ["draft"], unmatched: [] });
});

// ── #921 appendBody — knowledge_save(mode='append')의 본문 병합. 호출자는 본문을 읽지 않으므로(그게 요점)
//  base 가 개행으로 끝나는지 모른다 → 구분자 정규화는 전적으로 서버 책임이고, base 원문은 불변이어야 한다. ──
t("#921: 기본 결합 — 빈 줄 하나로 이어 마크다운 블록 경계 보장", () => {
  assert.equal(appendBody("# 제목", "- 항목"), "# 제목\n\n- 항목");
});
t("#921: base 의 끝 개행 유무와 무관하게 같은 결과(호출자가 알 수 없는 값이라 서버가 정규화)", () => {
  const want = "본문\n\n추가";
  assert.equal(appendBody("본문", "추가"), want);
  assert.equal(appendBody("본문\n", "추가"), want);
  assert.equal(appendBody("본문\n\n\n", "추가"), want);
  assert.equal(appendBody("본문   \n  ", "추가"), want);
});
t("#921: chunk 의 앞 개행·뒤 공백 제거(빈 줄 폭주 방지)", () => {
  assert.equal(appendBody("본문", "\n\n추가\n\n"), "본문\n\n추가");
});
t("#921: chunk 첫 줄의 들여쓰기는 보존 — 앞 '개행'만 지운다(들여쓴 코드블록이 깨지면 안 됨)", () => {
  assert.equal(appendBody("본문", "\n    code()"), "본문\n\n    code()");
});
// ── 핵심 불변식: base 는 끝 공백 말고 아무것도 안 바뀐다. append 의 존재 이유가 '원문유지'다. ──
t("#921: base 원문 불변 — 내부 공백·빈 줄·마크다운이 그대로 남는다", () => {
  const base = "# 런북\n\n## 1단계\n\n    들여쓴 코드\n\n- a\n- b";
  const got = appendBody(base, "## 2단계");
  assert.equal(got.slice(0, base.length), base, "base 가 손상되면 안 됨");
  assert.equal(got, `${base}\n\n## 2단계`);
});
t("#921: 반복 append 는 누적된다(앞선 조각이 유실되지 않음)", () => {
  assert.equal(appendBody(appendBody("A", "B"), "C"), "A\n\nB\n\nC");
});
// ── 경계: 한쪽이 비면 구분자를 넣지 않는다(문서가 빈 줄로 시작/끝나지 않게). ──
t("#921: base 가 비면(폴더 등 빈 본문) chunk 만 — 앞에 빈 줄이 붙지 않는다", () => {
  assert.equal(appendBody("", "추가"), "추가");
  assert.equal(appendBody("   \n ", "추가"), "추가");
});
t("#921: chunk 가 사실상 비면 base 그대로(no-op)", () => {
  assert.equal(appendBody("본문", "\n\n  "), "본문");
});

// ── #921 isDuplicateAppend — append 는 replace 와 달리 멱등이 아니다(재시도 = 같은 단락 두 번).
//  호출자는 본문을 안 읽어 중복을 스스로 못 보므로 서버가 꼬리 정확일치로 잡는다. ──
t("#921: 방금 붙인 조각을 그대로 재시도 → 중복으로 감지(응답 유실 후 재시도 시나리오)", () => {
  const chunk = "## 2단계\n\n덧붙인 내용";
  assert.equal(isDuplicateAppend(appendBody("# 런북", chunk), chunk), true);
});
t("#921: appendBody 와 같은 정규화를 본다 — 앞 개행·뒤 공백이 달라도 같은 조각으로 감지", () => {
  const stored = appendBody("# 런북", "## 2단계");
  assert.equal(isDuplicateAppend(stored, "\n\n## 2단계\n\n"), true, "정규화가 어긋나면 감지가 헛돈다");
});
t("#921: 다른 조각은 중복 아님(정상 append 를 막으면 안 됨)", () => {
  assert.equal(isDuplicateAppend(appendBody("# 런북", "## 2단계"), "## 3단계"), false);
});
t("#921: 꼬리가 아니라 중간에 같은 내용이 있는 건 중복 아님(그 뒤로 더 붙은 상태 = 정상)", () => {
  const body = appendBody(appendBody("# 런북", "## 2단계"), "## 3단계");
  assert.equal(isDuplicateAppend(body, "## 2단계"), false);
});
t("#921: 빈 조각은 중복 판정 대상 아님", () => {
  assert.equal(isDuplicateAppend("# 런북", "\n\n  "), false);
});

// ── #1091 카테고리 축 — 특정 카테고리 | 스페이스 | **미분류**(어느 카테고리 목록에도 안 뜨는 지식) 셋 중 하나.
//  WIKI 사이드바의 '미분류' 노드·검색이 이 축에 기댄다. 이 축이 조용히 무력화되면 필터가 no-op 이 되어
//  **에러 없이 '전체가 다 나오는'** 오답이 된다(빈 화면이 아니라 그럴듯한 오답이라 눈으로 못 잡는다).
//  또 축을 겹쳐 적용하면(카테고리 지정 + 미분류) 결과가 항상 0건 — 이것도 조용하다. 그래서 조립 결과를 직접 잠근다.
const uncatWhere = /NOT EXISTS \(SELECT 1 FROM knowledge_category kcu WHERE kcu\.name=k\.name AND kcu\.state<>'rejected'\)/;
const catJoin = /JOIN knowledge_category/;

t("#1091 ①: 미분류만 → 미분류 술어 O · 카테고리 조인 X · 파라미터 없음", () => {
  const r = knowledgeListFilter({ uncategorized: true });
  assert.match(r.where, uncatWhere, "술어가 빠지면 필터가 no-op — 전체가 미분류로 나온다");
  assert.doesNotMatch(r.join, catJoin, "조인하면 정의상 0건이 된다");
  assert.deepEqual(r.params, []);
});
t("#1091 ②: 미분류 + 카테고리 → 카테고리가 이긴다(겹쳐 걸면 항상 0건)", () => {
  const r = knowledgeListFilter({ uncategorized: true, categoryId: 22 });
  assert.doesNotMatch(r.where, uncatWhere);
  assert.match(r.join, catJoin);
  assert.deepEqual(r.params, [22]);
});
// ③·⑥(스페이스 축) 은 #1631 에서 사라졌다 — 분류축 위의 고정 서랍장(business/product/system)을 걷어내
//  '어느 카테고리냐' 하나만 남았다. 두 시나리오는 존재하지 않는 입력을 시험하던 것이라 지운다(번호는 안 당긴다).
t("#1091 ④: 축 미지정 → 미분류 술어 없음(전체 조회가 미분류로 좁혀지면 안 된다)", () => {
  assert.doesNotMatch(knowledgeListFilter({}).where, uncatWhere);
});
t("#1091 ⑤: 카테고리만 → 종전 그대로(미분류 술어 없음)", () => {
  const r = knowledgeListFilter({ categoryId: 22 });
  assert.doesNotMatch(r.where, uncatWhere);
  assert.match(r.join, catJoin);
  assert.deepEqual(r.params, [22]);
});
t("#1091 ⑦: 미분류 + 다른 조건 → 둘 다 걸리고, 미분류 술어는 파라미터를 안 먹는다($1 유지)", () => {
  const r = knowledgeListFilter({ uncategorized: true, injection: "recalled" });
  assert.match(r.where, uncatWhere);
  assert.match(r.where, /k\.injection=\$1/, "미분류 술어가 파라미터를 먹으면 뒤 조건의 자리번호가 밀린다");
  assert.deepEqual(r.params, ["recalled"]);
});

// ── #1247 WIKI 인덱스 핀 조회(listWikiPins) — '조용한 절단' 금지. ──
//  사양: 매 세션 주입되는 인덱스에는 **활성 핀 전량**이 들어간다. 빠지는 사유는 '핀이 아님 / 활성이 아님' 둘뿐이고,
//  조직의 지식이 몇 건이냐·그 핀을 최근에 고쳤냐는 포함 여부에 영향을 주지 않는다(결정적).
//  실제 사고(2026-07-29): 렌더가 일반 목록 500건(updated_at DESC)을 받아 **메모리에서** is_wiki 를 걸렀다.
//   활성 지식이 500건을 넘는 조직에선 그 창 밖의 핀이 인덱스에서 사라졌는데 에러도 경고도 없었다
//   (고객사 A 실박스: 활성 1,173건 → 핀 3건 중 1건만 주입 / 라이블리 dev: 589건 → 10건 중 9건).
//   남는 기준이 '최근 수정'이라 커넥터 싱크마다 구성이 바뀌어 재현조차 흔들렸다.
//  그래서 부작용(가짜 lister 가 받은 필터·호출 횟수·offset)으로 잠근다 — 문구 매칭이 아니라 '무엇을 물어봤나'.
const pinRow = (name: string): KnowledgeRow => ({
  name, title: name, body_md: "", injection: "recalled", provenance: "authored", lifecycle: "active",
  confidence: "human", source: "authored", summary: null, sort: 0, is_wiki: true, is_folder: false,
  version: 1, updated_at: "2026-07-29T00:00:00.000Z",
});
// 호출 인자를 기록하는 가짜 lister — pageSizes[i] = i 번째 호출이 돌려줄 행 수(부족하면 0=끝).
const fakeLister = (pageSizes: number[]): { calls: KnowledgeFilter[]; lister: (f: KnowledgeFilter) => Promise<KnowledgeRow[]> } => {
  const calls: KnowledgeFilter[] = [];
  return {
    calls,
    lister: (f: KnowledgeFilter) => {
      const n = pageSizes[calls.length] ?? 0;
      calls.push(f);
      return Promise.resolve(Array.from({ length: n }, (_, i) => pinRow(`pin-${calls.length}-${i}`)));
    },
  };
};
// 영원히 꽉 찬 페이지를 주는 비정상 lister(E6) — 순회 루프가 스스로 멈추는지 본다.
const alwaysFullLister = (): { calls: KnowledgeFilter[]; lister: (f: KnowledgeFilter) => Promise<KnowledgeRow[]> } => {
  const calls: KnowledgeFilter[] = [];
  return {
    calls,
    lister: (f: KnowledgeFilter) => {
      calls.push(f);
      return Promise.resolve(Array.from({ length: Number(f.limit) || 500 }, (_, i) => pinRow(`p${calls.length}-${i}`)));
    },
  };
};

const tA = async (name: string, fn: () => Promise<void>): Promise<void> => {
  await fn();
  pass++;
  console.log(`ok  ${name}`);
};

// E7 — 필터가 DB 로 내려가야 한다. 이게 깨지면 일반 목록을 받아 메모리에서 거르는 원 버그로 되돌아간다.
await tA("#1247 E7: is_wiki·lifecycle 을 조회 필터로 내린다(메모리 필터 금지)", async () => {
  const { calls, lister } = fakeLister([2]);
  const pins = await listWikiPins(null, lister);
  assert.equal(calls.length, 1, "조회가 아예 안 불렸으면 이 테스트는 아무것도 안 본 것(배선 단언)");
  assert.equal(pins.length, 2);
  assert.equal(calls[0].is_wiki, true, "is_wiki 를 안 넘기면 일반 목록이 와서 창 밖 핀이 조용히 빠진다 — 그게 원 버그");
  assert.equal(calls[0].lifecycle, "active", "활성만 — 검토대기·아카이브 핀이 인덱스에 섞이면 안 된다");
  assert.equal(calls[0].light, true, "인덱스는 소환키·제목만 쓴다 — 본문까지 실어오면 매 세션 주입이 무거워진다");
  // updated_at 은 미러 인입분이 날짜 단위로 뭉쳐 동률이라 페이지 경계에서 행이 중복/누락된다(#709) → 전순서(name).
  assert.equal(calls[0].orderBy, "name", "페이지 경계가 흔들리면 순회 자체가 핀을 잃는다");
});

// E2 — 경계값. 페이지가 상한과 '정확히 같은' 건수로 오면 다음 페이지가 남아 있을 수 있다.
await tA("#1247 E2: 페이지가 정확히 꽉 차면(500) 다음 페이지를 잇는다", async () => {
  const { calls, lister } = fakeLister([500, 0]);
  const pins = await listWikiPins(null, lister);
  assert.equal(pins.length, 500);
  assert.equal(calls.length, 2, "꽉 찬 페이지에서 멈추면 501번째 핀부터 조용히 사라진다");
  assert.equal(calls[1].offset, 500, "offset 이 안 밀리면 같은 페이지를 다시 읽는다(중복·무한)");
});

// E3 — 경계 +1. 상한을 1건 넘으면 그 1건이 반드시 따라와야 한다.
await tA("#1247 E3: 상한 +1(501)이면 501건 전부", async () => {
  const { calls, lister } = fakeLister([500, 1]);
  const pins = await listWikiPins(null, lister);
  assert.equal(pins.length, 501);
  assert.deepEqual(calls.map((c) => c.offset), [0, 500]);
  assert.equal(new Set(pins.map((p) => p.name)).size, 501, "페이지가 겹쳐 오면 같은 핀이 인덱스에 두 번 실린다");
});

// E5 — 덜 찬 페이지면 거기서 끝(불필요한 왕복 금지).
await tA("#1247 E5: 페이지가 덜 찼으면 추가 조회 없이 종료", async () => {
  const { calls, lister } = fakeLister([3, 99]);
  assert.equal((await listWikiPins(null, lister)).length, 3);
  assert.equal(calls.length, 1, "덜 찬 페이지 뒤로 더 물으면 매 세션 주입에 헛왕복이 붙는다");
});

// E4 — 핀 0건이면 빈 결과(렌더가 ${wiki} 블록을 생략하도록 — 빈 섹션 헤더만 남기면 안 된다).
await tA("#1247 E4: 핀 0건이면 빈 배열", async () => {
  const { calls, lister } = fakeLister([0]);
  assert.deepEqual(await listWikiPins(null, lister), []);
  assert.equal(calls.length, 1);
});

// E6 — 이번에 새로 도입한 것(순회 루프·주입 seam)이 비정상 입력을 만났을 때.
//  '항상 꽉 찬 페이지'는 실 DB 에선 안 나오지만, 루프가 종료 조건을 페이지 크기에만 의존하므로
//  그 가정이 깨졌을 때 매 세션 주입이 영원히 안 끝나는(=세션이 안 뜨는) 사고로 번진다.
await tA("#1247 E6: 페이지가 영원히 꽉 차도 유한 횟수에 종료한다(무한루프 금지)", async () => {
  const { calls, lister } = alwaysFullLister();
  const pins = await listWikiPins(null, lister);
  assert.ok(calls.length > 1, "여러 페이지를 실제로 순회했는지(배선 단언)");
  assert.ok(calls.length <= 32, `유한 종료 — 실제 호출 ${calls.length}회`);
  assert.equal(pins.length, calls.length * 500);
});
await tA("#1247 E6-b: lister 는 optional seam(#1291 viewer 만 필수) — 호출자는 lister 없이 부른다", async () => {
  // viewer(#1291)는 **의도적으로** 필수다: 이 인덱스는 매 세션 통째로 주입되는 자리라, 생략 가능하면 호출부 한 곳만
  //  놓쳐도 잠긴 지식의 소환키가 전원에게 조용히 샌다(컴파일 에러로 잡히게 만든 것). 반면 lister 는 여전히 optional —
  //  필수가 되면 세 렌더 표면(publish·materialize·guide-preview)이 각자 조회를 조립하게 되고 그게 #1247 의 원인이었다.
  assert.equal(listWikiPins.length, 1, "필수 인자는 viewer 하나뿐이어야 한다(lister 가 필수가 되면 렌더 표면이 갈라진다)");
});


// ════════════════════════════════════════════════════════════════════════════
// #1531 applyKnowledgeEdits — 본문 일부만 정확일치로 치환(문서 중간 갱신).
//  이 함수가 없던 동안 유일한 수단이 전문 교체였고, 그래서 40K자 문서를 갱신하다 무관한 문장의 쉼표가
//  여는 괄호로 바뀌어 괄호가 닫히지 않는 손상이 실제로 났다(어니스트 #1531). 여기서 잠그는 것은
//  "안 건드린 부분은 문자 단위로 그대로다" 와 "못 찾으면 조용히 넘어가지 않는다" 두 가지다.
// ════════════════════════════════════════════════════════════════════════════
const DOC = [
  "# 제주은행",
  "",
  "## 13. 열린 이슈 (2026-07-29 기준)",
  "",
  "1. 가심사 조회 속도 개선 미해결",
  "5. 포트폴리오 제안 진행 상태 미확인.",
  "",
  "## 14. 부록",
  "진행 상태 미확인.",
].join("\n");

t("E1: 한 조각만 바뀌고 나머지는 문자 단위로 그대로다", () => {
  const out = applyKnowledgeEdits(DOC, [
    { old: "## 13. 열린 이슈 (2026-07-29 기준)", new: "## 13. 열린 이슈 (2026-08-03 기준)" },
  ]);
  assert.ok(out.includes("## 13. 열린 이슈 (2026-08-03 기준)"));
  // 나머지 줄은 하나도 안 변했다 — 이 모드의 존재 이유.
  assert.equal(out.replace("2026-08-03", "2026-07-29"), DOC);
});

t("E2: 여러 편집을 순차 적용한다", () => {
  const out = applyKnowledgeEdits(DOC, [
    { old: "2026-07-29 기준", new: "2026-08-03 기준" },
    { old: "1. 가심사 조회 속도 개선 미해결", new: "1. 가심사 조회 속도 — NICE 측 원인 규명 중" },
  ]);
  assert.ok(out.includes("2026-08-03 기준"));
  assert.ok(out.includes("NICE 측 원인 규명 중"));
  assert.ok(!out.includes("1. 가심사 조회 속도 개선 미해결"));
});

t("E3: 못 찾으면 던진다 — 조용히 넘어가면 '저장했는데 안 바뀐' 최악의 실패가 된다", () => {
  assert.throws(() => applyKnowledgeEdits(DOC, [{ old: "존재하지 않는 문장", new: "x" }]),
    /찾지 못했습니다/);
});

t("E4: 여러 곳에 있으면 모호하므로 던진다(replace_all 없이는)", () => {
  // "진행 상태 미확인." 은 13장과 14장 두 곳에 있다.
  assert.throws(() => applyKnowledgeEdits(DOC, [{ old: "진행 상태 미확인.", new: "재문의 인입." }]),
    /2곳 있어/);
});

t("E5: replace_all 을 명시하면 전부 바꾼다", () => {
  const out = applyKnowledgeEdits(DOC, [{ old: "진행 상태 미확인.", new: "재문의 인입.", replace_all: true }]);
  assert.equal(out.split("재문의 인입.").length - 1, 2);
  assert.ok(!out.includes("진행 상태 미확인."));
});

t("E6: new 가 빈 문자열이면 삭제다", () => {
  const out = applyKnowledgeEdits(DOC, [{ old: "1. 가심사 조회 속도 개선 미해결\n", new: "" }]);
  assert.ok(!out.includes("가심사"));
  assert.ok(out.includes("5. 포트폴리오 제안"));
});

t("E7: 앞 편집이 뒤 앵커를 지웠으면 '못 찾음'으로 드러난다(조용한 무시 금지)", () => {
  assert.throws(() => applyKnowledgeEdits(DOC, [
    { old: "5. 포트폴리오 제안 진행 상태 미확인.", new: "5. 포트폴리오 제안 — 재문의 인입." },
    { old: "5. 포트폴리오 제안 진행 상태 미확인.", new: "또 바꾸기" },
  ]), /찾지 못했습니다/);
});

t("E8: 빈 edits·빈 old·old==new 는 거부한다", () => {
  assert.throws(() => applyKnowledgeEdits(DOC, []), /비었습니다/);
  assert.throws(() => applyKnowledgeEdits(DOC, [{ old: "", new: "x" }]), /old 가 비었습니다/);
  assert.throws(() => applyKnowledgeEdits(DOC, [{ old: "## 14. 부록", new: "## 14. 부록" }]), /같습니다/);
});

t("E9: 여러 줄 앵커(줄바꿈 포함)도 정확일치로 다룬다", () => {
  const out = applyKnowledgeEdits(DOC, [
    { old: "## 14. 부록\n진행 상태 미확인.", new: "## 14. 부록\n2026-08 갱신됨." },
  ]);
  assert.ok(out.includes("## 14. 부록\n2026-08 갱신됨."));
  assert.ok(out.includes("5. 포트폴리오 제안 진행 상태 미확인.")); // 13장 쪽은 그대로
});

console.log(`\n${pass} passed`);
