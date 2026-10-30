// 카테고리 설정이 **왜** 안 됐는지 말한다 (#2474) — 말하지 않는 no-op 을 말하는 no-op 으로.
//
// 배경(2026-09-01 실측): `project_set_categories_v6` 가 `{categoryIds: []}` 만 돌려줘서, 호출한 AI 가
//  «툴이 고장났다» 로 오진하고 사용자에게 그렇게 보고했다. 실제로는 설계된 동작이었다 — 카테고리는
//  **리스트가 소유하고 프로젝트가 상속**하므로 리스트 없는 프로젝트엔 반영할 자리가 없다.
//  설계는 옳았고(성공을 가장하지 않는다), 빠진 것은 **사유**였다.
//
// ★ 이 파일이 잠그는 핵심: **실패한 `[]` 와 성공적으로 해제한 `[]` 는 겉모습이 같다.**
//   그 둘을 가르는 유일한 값이 `applied` 다(E4 ↔ E3). 그게 없으면 호출자는 영원히 구분하지 못한다.
//
// ⚠ 2026-09-03(#1631) 계약 변경 — **카테고리를 정하면 자리를 만들어 준다.** 종전 E1(리스트 없음 + 축 지정)은
//  «말하는 no-op» 이었는데, 그건 사유를 말할 뿐 여전히 **막다른 길**이었다: 세션이 자동 생성하는 프로젝트는
//  리스트 없이 태어나고 리스트를 정해 주는 경로가 없어서, 실측(dev 페르소나 2명) 프로젝트 7개 중 카테고리가
//  붙은 것이 0이었다. 이제 그 축을 소유한 리스트를 찾고(형제와 공유), 없으면 만든다.
//  **해제(빈 배열)는 여전히 자리를 만들지 않는다** — 없는 것을 지우려고 자리를 만들 이유가 없다(E4 유지).
//
// ── 입력 조합 × 기대 (엣지 표 — 행마다 테스트 ≥1) ─────────────────────────────
// #  | 소속 리스트 | 입력 categoryIds | 기대
// E1 | 없음        | [55]             | 그 축의 리스트에 넣는다 → applied=true · categoryIds=[55] (계약 변경)
// E2 | 있음        | [55]             | applied=true · reason=null · categoryIds=[55] · UPDATE 1건
// E3 | 있음        | [] (해제)        | applied=true · categoryIds=[]  ← E4 와 배열은 같고 applied 가 다르다
// E4 | 없음        | [] (해제)        | applied=false · reason="no_list" — 해제는 자리를 만들지 않는다
// E5 | 있음        | [55] 재설정      | applied=true · categoryIds=[55] · UPDATE 0건(무변경 — 허위 audit 방지)
// E6 | 있음        | [55, 53]         | 첫 항목만 → [55] (하위호환 계약 유지)
//
// ⚠ 여기 페이크는 «그 축의 리스트가 **이미 있는**» 갈래만 태운다(형제 공유). «없어서 새로 만드는» 갈래는
//  createProjectList 까지 내려가 실 DB 가 필요하므로 scripts/category-reach.itest.mjs 의 ②가 본다.
//
// 실행: npm run build && node dist/v6/project-categories-noop.test.js
import assert from "node:assert/strict";
import { itemsPool } from "../db/client.js";
import { setProjectCategories } from "./project-store.js";

let pass = 0;
const ok = (n: string): void => { pass++; console.log(`ok  ${n}`); };

// ── 얇은 Db 페이크 — setListCategoryForProject 가 만지는 세 쿼리만 라우팅한다. ──
//  (미처리 SQL 은 던진다 — 페이크가 조용히 빈 결과를 주면 테스트가 통과하면서 아무것도 안 본다.)
const state = {
  listId: null as number | null,      // 프로젝트의 소속 리스트
  categoryId: null as number | null,  // 그 리스트의 현재 카테고리
  listForCat: null as number | null,  // 그 카테고리를 이미 소유한 리스트(형제 공유 대상)
  updates: 0,
  audits: 0,
  attached: 0,                        // 프로젝트를 리스트에 넣은 횟수(#1631)
};

(itemsPool as any).query = async (sqlIn: unknown, params: unknown[] = []) => {
  const sql = String(sqlIn).replace(/\s+/g, " ").trim();
  const p = params as any[];
  if (sql.startsWith("SELECT p.list_id, pl.category_id FROM project p")) {
    return { rows: [{ list_id: state.listId, category_id: state.categoryId }] };
  }
  //  #1631 — 자리 만들기 경로. listIdOfProject → 축 조회 → 그 축의 리스트 찾기 → 프로젝트를 넣기.
  if (sql.startsWith("SELECT list_id FROM project WHERE id=")) {
    return { rows: [{ list_id: state.listId }] };
  }
  // 없는 카테고리 id 를 404 로 끊는 존재확인(project-store) — 이 테스트의 id 는 존재하는 것으로 둔다.
  if (sql.startsWith("SELECT 1 AS ok FROM category WHERE id")) {
    return { rows: [{ ok: 1 }] };
  }
  if (sql.startsWith("SELECT name, key FROM category WHERE id=")) {
    return { rows: [{ name: "거래처", key: "partners" }] };
  }
  if (sql.startsWith("SELECT id FROM project_list WHERE category_id=")) {
    return { rows: state.listForCat == null ? [] : [{ id: state.listForCat }] };
  }
  if (sql.startsWith("UPDATE project SET list_id=")) {
    state.attached++;
    state.listId = (p[1] ?? null) as number | null;
    return { rows: [] };
  }
  if (sql.startsWith("UPDATE project_list SET category_id")) {
    state.updates++;
    state.categoryId = p[1] ?? null;
    return { rows: [] };
  }
  if (sql.startsWith("INSERT INTO org_content_audit")) {
    state.audits++;
    return { rows: [] };
  }
  throw new Error("unhandled SQL in fake: " + sql);
};

const reset = (listId: number | null, categoryId: number | null, listForCat: number | null = null): void => {
  state.listId = listId;
  state.categoryId = categoryId;
  state.listForCat = listForCat;
  state.updates = 0;
  state.audits = 0;
  state.attached = 0;
};

// E1 — 미분류 프로젝트에 축을 정한다. 그 축을 이미 소유한 리스트(43)가 있으니 **거기 넣는다**(형제 공유).
{
  reset(null, null, 43);
  const r = await setProjectCategories(1, [55]);
  assert.equal(r.applied, true, "E1 자리를 만들어 줬으니 반영된다(종전엔 no-op 이었다)");
  assert.deepEqual(r.categoryIds, [55]);
  assert.equal(r.listId, 43, "E1 그 축을 이미 소유한 리스트에 붙는다");
  assert.equal(state.attached, 1, "E1 프로젝트를 리스트에 넣는 쓰기가 정확히 한 번");
  ok("E1 리스트 없음 + 그 축의 리스트 있음 → 거기 붙고 applied=true (형제 공유)");
}

// E2 — 정상 경로.
{
  reset(43, null);
  const r = await setProjectCategories(1, [55]);
  assert.deepEqual(r.categoryIds, [55]);
  assert.equal(r.applied, true);
  assert.equal(r.reason, null, "E2 성공에 사유가 붙으면 안 된다");
  assert.equal(r.listId, 43);
  assert.equal(state.updates, 1, "E2 실제로 리스트 카테고리를 써야 한다");
  ok("E2 리스트 있음 → categoryIds=[55] · applied=true · UPDATE 1건");
}

// E3 ★ 핵심 — 성공적으로 **해제**해도 배열은 `[]` 다. E4(자리 없는 해제)와 배열만으로는 구분되지 않는다.
{
  reset(43, 55);
  const r = await setProjectCategories(1, []);
  assert.deepEqual(r.categoryIds, [], "E3 해제했으니 빈 배열");
  assert.equal(r.applied, true, "E3 해제는 성공이다 — 실패로 보이면 안 된다");
  assert.equal(r.reason, null);
  ok("E3 해제 → categoryIds=[] 이지만 applied=true (E4 와 갈린다)");
}

// ★ 배선 단언 — E4 와 E3 이 정말로 `categoryIds` 만으로는 구분 불가함을 못박는다.
//   이 단언이 없으면 "applied 가 왜 필요한가"가 코드 어디에도 남지 않는다.
{
  //  #1631 뒤로 «실패한 []» 는 **해제인데 자리가 없는** 경우다(축 지정은 자리를 만들어 주므로 더는 실패하지 않는다).
  reset(null, null);
  const fail = await setProjectCategories(1, []);
  reset(43, 55);
  const cleared = await setProjectCategories(1, []);
  assert.deepEqual(fail.categoryIds, cleared.categoryIds, "두 경우의 배열이 같아야 이 문제가 성립한다");
  assert.notEqual(fail.applied, cleared.applied, "★ applied 가 그 둘을 가르는 유일한 값이다");
  ok("★ 배선 — 실패한 [] 와 해제한 [] 는 applied 로만 갈린다");
}

// E4 ★ — 해제는 **자리를 만들지 않는다**. 없는 것을 지우려고 리스트를 만들 이유가 없다(#1631 A3).
{
  reset(null, null, 43);   // 그 축의 리스트가 있어도 해제라면 붙지 않는다
  const r = await setProjectCategories(1, []);
  assert.equal(r.applied, false, "E4 자리가 없으면 해제도 실패다");
  assert.equal(r.reason, "no_list");
  assert.equal(state.updates, 0);
  assert.equal(state.attached, 0, "★ E4 해제가 프로젝트를 리스트에 붙이면 안 된다");
  ok("E4 리스트 없음 + 해제 → applied=false · 붙이기 0건 · 쓰기 0건");
}

// E5 — 같은 값 재설정은 성공이되 쓰기·감사는 없어야 한다(허위 audit 방지 계약).
{
  reset(43, 55);
  const r = await setProjectCategories(1, [55]);
  assert.deepEqual(r.categoryIds, [55]);
  assert.equal(r.applied, true);
  assert.equal(state.updates, 0, "E5 무변경인데 UPDATE 가 나갔다 — 허위 audit");
  assert.equal(state.audits, 0, "E5 무변경인데 감사가 남았다");
  ok("E5 같은 값 재설정 → applied=true · UPDATE 0건 · 감사 0건");
}

// E6 — 배열은 하위호환 인자다. 첫 항목만 반영한다는 계약이 바뀌면 안 된다.
{
  reset(43, null);
  const r = await setProjectCategories(1, [55, 53]);
  assert.deepEqual(r.categoryIds, [55], "E6 첫 항목만 반영(하위호환 계약)");
  assert.equal(state.categoryId, 55);
  ok("E6 여러 개 → 첫 항목만 반영");
}

console.log(`\nproject-categories-noop tests: ${pass} passed`);
