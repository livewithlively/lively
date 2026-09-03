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
    cross_cutting: true, state: "deprecated",
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

// state 는 두 값만 지나간다 — 아무 문자열이나 통과하면 zod 가 400 을 내지만, 여기서 먼저 거른다.
{
  const parse = parseOf("category_update");
  assert.equal(parse({ state: "active" }).state, "active");
  assert.equal(parse({ state: "merged" }).state, undefined, "merged 는 병합 경로가 소유한다 — 여기로 못 들어온다");
  assert.equal(parse({ state: "" }).state, undefined);
  assert.equal(parse({}).state, undefined, "미지정은 undefined — 부분 수정에서 «안 건드림» 이다");
}

// 만들 때도 같은 규율 — 스키마의 키가 parse 에 다 있나.
{
  const parse = parseOf("category_create");
  const out = parse({ key: "brewing", name: "양조", should: "가".repeat(50), description: "한 줄", cross_cutting: true });
  for (const k of Object.keys(cap("category_create").input as Record<string, unknown>)) {
    assert.ok(k in out, `★ category_create.${k} 가 REST parse 에서 사라진다`);
  }
}

console.log("ok  분류축 REST parse — 입력 스키마의 필드를 하나도 빠뜨리지 않는다(state 포함)");
