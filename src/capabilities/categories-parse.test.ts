// #1631 — 분류축 REST parse 가 입력 스키마의 필드를 **빠뜨리지 않는가**.
//
//  왜 이 테스트가 있나(dev 실측 2026-09-03): `state`(축 치우기)를 zod 입력에는 넣고 REST parse 에는
//  안 넣었다. 그래서 MCP 로는 동작하는데 **웹·REST 에서는 200 을 받고 아무 일도 안 했다** — 실패조차
//  아니라 아무도 몰랐다. 웹 [치우기] 버튼이 정확히 그 경로다.
//  단위테스트가 스토어 함수를 직접 부르면 이 층을 통째로 건너뛴다(그래서 통합테스트도 못 잡았다).
//
//  ★ 이 파일이 잠그는 것: **zod 입력에 있는 필드는 REST parse 도 반드시 다룬다.**
import assert from "node:assert/strict";
import { registry } from "./index.js";

const cap = (name: string) => {
  const c = registry.get(name);
  assert.ok(c, `${name} op 이 있어야 한다`);
  return c;
};
const parseOf = (name: string) => {
  const mounts = cap(name).expose?.rest;
  assert.ok(Array.isArray(mounts) && mounts.length, `${name} 에 REST 마운트가 있어야 한다`);
  const rest = mounts[0];
  assert.ok(rest?.parse, `${name} 에 REST parse 가 있어야 한다`);
  return (body: Record<string, unknown>, params: Record<string, unknown> = { id: "7" }) =>
    (rest.parse as (r: unknown) => Record<string, unknown>)({ body, params, query: {} });
};

// ★ 배선 겸 핵심 단언 — 입력 스키마의 키가 parse 결과에도 나타나는가.
//  (id 는 경로 파라미터라 body 가 아니라 params 에서 온다 — 그래서 값을 따로 준다.)
{
  const parse = parseOf("category_update");
  const keys = Object.keys(cap("category_update").input as Record<string, unknown>);
  const body: Record<string, unknown> = {
    name: "새 이름", description: "한 줄", should: "가".repeat(50),
    cross_cutting: true, state: "deprecated", group: "align",
  };
  //  스키마에 키가 늘었는데 이 표를 안 고치면 여기서 걸린다 — «parse 에 빠뜨림» 과 같은 자리다.
  const untested = keys.filter((k) => k !== "id" && !(k in body));
  assert.deepEqual(untested, [], `입력 스키마에 새 키가 생겼다 — 이 테스트의 body 와 parse 둘 다 고쳐라: ${untested.join(", ")}`);

  const out = parse(body);
  for (const k of keys) {
    assert.ok(k in out, `★ category_update.${k} 가 REST parse 에서 사라진다 — 웹에서 조용히 무시된다`);
  }
  assert.equal(out.id, 7, "id 는 경로에서 온다");
  assert.equal(out.state, "deprecated", "치우기 값이 그대로 실려야 한다");
}

// ★ parse 는 값을 **거르지 않는다.** REST 경로엔 zod 검증이 없어서(입력 스키마는 MCP·표면 스냅샷용),
//  여기서 모르는 값을 undefined 로 떨구면 스토어의 가드가 영영 안 돌고 200 이 나간다 — 조용한 no-op 이다.
//  실제 판정은 스토어 한 곳(updateCategory)에서만 하고, 그게 400 을 내는 건 itest ⑨가 잠근다.
{
  const parse = parseOf("category_update");
  assert.equal(parse({ state: "active" }).state, "active");
  assert.equal(parse({ state: "deprecated" }).state, "deprecated");
  assert.equal(parse({ state: "merged" }).state, "merged",
    "★ 거르지 말고 넘겨야 스토어가 «merged 는 병합 경로가 정합니다» 로 400 을 낼 수 있다");
  assert.equal(parse({ state: "아무거나" }).state, "아무거나", "모르는 값도 스토어까지 간다(거기서 거절된다)");
  assert.equal(parse({}).state, undefined, "미지정은 undefined — 부분 수정에서 «안 건드림» 이다");
}

// ★ 묶음(group, #1631)은 **3상**이다 — 키 부재=미변경 / null·빈 문자열=해제 / 값=그 묶음.
//  `b.group != null ? String(b.group) : undefined` 로 읽으면 null(해제)이 미변경으로 뭉개져,
//  웹에서 [묶음 빼기] 를 눌러도 200 을 받고 아무 일도 안 한다 — state 때 겪은 그 조용한 no-op 과 같은 자리다.
{
  const parse = parseOf("category_update");
  assert.equal(parse({}).group, undefined, "미지정은 undefined(안 건드림)");
  assert.ok("group" in parse({}), "키 자체는 살아 있어야 한다 — 핸들러가 3상을 구분한다");
  assert.equal(parse({ group: null }).group, null, "★ null 은 «해제» 다(미변경으로 뭉개면 안 된다)");
  assert.equal(parse({ group: "" }).group, "", "빈 문자열도 해제로 스토어까지 간다");
  assert.equal(parse({ group: "align" }).group, "align");
  assert.equal(parse({ group: "없는묶음" }).group, "없는묶음",
    "★ 거르지 말고 넘겨야 스토어가 «그런 묶음이 없습니다» 로 400 을 낼 수 있다");
}

// 만들 때도 같은 규율 — 스키마의 키가 parse 에 다 있나.
{
  const parse = parseOf("category_create");
  const out = parse({ key: "brewing", name: "양조", should: "가".repeat(50), description: "한 줄", cross_cutting: true, group: "work" });
  for (const k of Object.keys(cap("category_create").input as Record<string, unknown>)) {
    assert.ok(k in out, `★ category_create.${k} 가 REST parse 에서 사라진다`);
  }
  assert.equal(out.group, "work", "만들 때 정한 묶음이 그대로 실려야 한다");
  assert.equal(parse({ key: "brewing", name: "양조", should: "가".repeat(50) }).group, undefined, "안 주면 묶음 없음");
}

// 묶음 op(#1631) — key 를 안 줘도 만들 수 있어야 한다(이름에서 슬러그). 삭제는 경로 파라미터에서 key 가 온다.
{
  const upsert = parseOf("category_group_upsert");
  const out = upsert({ name: "내가 만든 것", hint: "작업물·문서", sort: 2 }, {});
  for (const k of Object.keys(cap("category_group_upsert").input as Record<string, unknown>)) {
    assert.ok(k in out, `★ category_group_upsert.${k} 가 REST parse 에서 사라진다`);
  }
  assert.equal(out.key, undefined, "key 를 안 주면 핸들러가 이름에서 슬러그를 만든다");
  assert.equal(out.hint, "작업물·문서", "★ 한 줄 뜻이 사라지면 리브·화면이 이름만 보고 고르게 된다");
  assert.equal(out.sort, 2);
  assert.equal(upsert({ name: "x", sort: "3" }).sort, 3, "숫자 문자열도 순서로 읽는다");
  assert.equal(upsert({ name: "x", sort: "나중" }).sort, undefined, "숫자가 아니면 미지정(기존 순서 보존)");
  assert.throws(() => upsert({ hint: "이름이 없다" }), /이름/, "이름 없이는 못 만든다");
  assert.throws(() => upsert({ key: "A 대문자 공백", name: "x" }), /슬러그/, "key 모양은 여기서 본다(경로가 아니라 값이다)");

  const remove = parseOf("category_group_remove");
  const rout = remove({ reassign_to: "ref" }, { key: "make" });
  for (const k of Object.keys(cap("category_group_remove").input as Record<string, unknown>)) {
    assert.ok(k in rout, `★ category_group_remove.${k} 가 REST parse 에서 사라진다`);
  }
  assert.equal(rout.key, "make", "지울 묶음은 경로에서 온다");
  assert.equal(rout.reassign_to, "ref");
  assert.equal(remove({}, { key: "make" }).reassign_to, null,
    "★ 안 주면 null 로 스토어까지 간다 — 거기서 «카테고리 N개가 있습니다» 로 거절된다");
}

console.log("ok  분류축 REST parse — 입력 스키마의 필드를 하나도 빠뜨리지 않는다(state·group·묶음 op 포함)");
