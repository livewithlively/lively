// getWritingFormat 캐시 — 워크스페이스별로 기억하고, 저장하면 곧바로 잊는가(2026-10-14 리뷰 H).
//  실행: npm run build && node dist/org/store/runtime-config-writing-format.test.js
//  실 DB 없이: itemsPool.query 를 페이크로 바꾸고, 페이크는 **지금 컨텍스트의 워크스페이스 행**을 돌려준다
//   (매니지드 공용 DB 에서 행 보안이 하는 일과 같은 모양 — 조회 하나가 보는 행은 그 요청의 워크스페이스 것뿐이다).
//
//  왜 캐시인가: 지식 저장마다(뒤따르는 PR 에선 지식 읽기마다) 형식을 읽는다 — 형식을 켜지 않은 조직(기본값)도 저장마다 조회가 늘었다.
//  왜 워크스페이스별인가: 매니지드 게이트웨이는 한 프로세스가 여러 워크스페이스를 돌린다. 전역 한 칸이면 먼저 읽은 워크스페이스의 형식으로
//   남의 저장을 거부하거나 통과시킨다(org/tenant-ttl-cache.ts 머리말의 2026-08-27 사고와 같은 모양).
//
//  엣지 표(입력 조합 × 기대):
//   C1 | 같은 워크스페이스에서 연달아 두 번                  | DB 조회 한 번(둘째는 캐시)
//   C2 | 워크스페이스 A(켬) · B(다른 형식)를 번갈아 · 역순도   | 각자 제 형식 — 먼저 읽은 쪽의 값이 남에게 새지 않는다
//   C3 | 컨텍스트 없음(셀프호스트) · A · B                    | 서로 다른 칸
//   C4 | A 에서 updateRuntimeConfig(writing_format)           | A 의 다음 조회가 곧바로 새 형식(TTL 을 기다리지 않는다)
//   C5 | A 저장 뒤 B 조회                                     | B 는 여전히 제 형식(무효화가 남의 값을 섞지 않는다)
//   C6 | writing_format 을 안 건드린 저장                      | 캐시 유지(조회가 늘지 않는다)
//   C7 | DB 를 직접 고침(다른 프로세스의 저장)                 | 30초 안에선 옛 값 · 지나면 새 값 · invalidateWritingFormatCache 뒤엔 곧바로 새 값
//   C8 | 조회 실패(구 DB · 장애)                               | 던지지 않는다 — 처음이면 기본값(꺼짐), 읽은 적 있으면 그 워크스페이스의 마지막 값
//   C9 | 받은 형식 객체를 호출자가 고쳐도                      | 다음 조회는 그대로(캐시가 오염되지 않는다)
import assert from "node:assert/strict";
import { itemsPool } from "../../db/client.js";
import { currentTenant, withTenant } from "../tenant-context.js";
import * as store from "./runtime-config.js";

/** INSERT INTO org_runtime_config(…) VALUES(…) 에서 한 칸에 실린 파라미터 — 칸 순서가 바뀌어도 따라간다. */
function columnParam(sql: string, params: unknown[], col: string): unknown {
  const head = /INSERT INTO org_runtime_config\(([^)]*)\)/.exec(sql);
  if (!head) return undefined;
  const cols = head[1].split(",").map((s) => s.trim());
  const at = sql.indexOf("VALUES(", head.index + head[0].length) + "VALUES(".length;
  const vals: string[] = [];
  let depth = 0, cur = "";
  for (let i = at; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "(") depth++;
    if (ch === ")") { if (depth === 0) { vals.push(cur.trim()); break; } depth--; }
    if (ch === "," && depth === 0) { vals.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  const n = /^\$(\d+)/.exec(vals[cols.indexOf(col)] ?? "");
  return n ? params[Number(n[1]) - 1] : undefined;
}

const SOLO = "(컨텍스트 없음)";
const rows = new Map<string, unknown>();   // 워크스페이스 → writing_format 원본
let reads = 0;
let failing = false;
(itemsPool as unknown as { query: unknown }).query = async (sql: string, params: unknown[] = []) => {
  const s = String(sql);
  const k = currentTenant()?.id ?? SOLO;
  if (failing) throw new Error("db down");
  if (/^\s*INSERT INTO org_runtime_config\(/.test(s)) {
    rows.set(k, JSON.parse(String(columnParam(s, params, "writing_format"))));
    return { rows: [], rowCount: 1 };
  }
  if (/^\s*SELECT writing_format FROM org_runtime_config/.test(s)) {
    reads++;
    return { rows: rows.has(k) ? [{ writing_format: rows.get(k) }] : [], rowCount: rows.has(k) ? 1 : 0 };
  }
  return { rows: [], rowCount: 0 };
};

// 가짜 시계 — 캐시 수명(30초)을 잰다.
let clock = 1_800_000_000_000;
Date.now = () => clock;

const T = (id: string) => ({ id, slug: id.slice(0, 2) });
const A = T("aaaaaaaa-0000-4000-8000-00000000000a");
const B = T("bbbbbbbb-0000-4000-8000-00000000000b");
const C = T("cccccccc-0000-4000-8000-00000000000c");
const read = (t: { id: string; slug: string } | null) => (t ? withTenant(t, () => store.getWritingFormat()) : store.getWritingFormat());
const counted = async <X>(fn: () => Promise<X>): Promise<{ v: X; n: number }> => { const r0 = reads; const v = await fn(); return { v, n: reads - r0 }; };
// 캐시가 없는 판(수정 전 코드)에도 이 시험 파일이 돌게 — 그 판엔 비울 캐시가 없다.
const forgetAll = (): void => { (store as { invalidateWritingFormatCache?: () => void }).invalidateWritingFormatCache?.(); };

let pass = 0;
const t = async (name: string, fn: () => Promise<void>): Promise<void> => { await fn(); pass++; console.log(`ok  ${name}`); };

async function main(): Promise<void> {
  rows.set(A.id, { enabled: true, rules: { local_path: "reject" } });
  rows.set(B.id, { enabled: true, register: "polite", apply_to: ["activity"] });
  rows.set(SOLO, { enabled: true, forbid_terms: ["solo-only"] });

  await t("C1 같은 워크스페이스의 둘째 조회는 캐시 — DB 조회 한 번", async () => {
    const first = await counted(() => read(A));
    const second = await counted(() => read(A));
    assert.equal(first.v.enabled, true);
    assert.equal(first.n, 1, "배선: 첫 조회는 DB 를 읽는다");
    assert.equal(second.n, 0, `둘째 조회가 DB 를 또 읽었다(${second.n}번) — 저장마다 조회가 느는 그대로다`);
    assert.equal(second.v.rules.local_path, "reject");
  });

  await t("C2 워크스페이스마다 제 형식 — 먼저 읽은 A 의 값이 B 에 새지 않는다(역순도)", async () => {
    const b = await read(B);
    assert.equal(b.register, "polite", "A 를 먼저 읽었어도 B 는 B 의 형식");
    assert.deepEqual(b.apply_to, ["activity"]);
    assert.equal(b.rules.local_path, undefined, "A 의 규칙이 B 에 실리면 안 된다");
    assert.equal((await read(A)).register, "plain", "B 를 읽은 뒤에도 A 는 A 의 형식");
    forgetAll();
    assert.equal((await read(B)).register, "polite");
    assert.equal((await read(A)).rules.local_path, "reject", "B 를 먼저 채운 뒤에도 A 는 A 의 형식");
  });

  await t("C3 컨텍스트 없음(셀프호스트)은 A · B 와 다른 칸", async () => {
    assert.deepEqual((await read(null)).forbid_terms, ["solo-only"]);
    assert.deepEqual((await read(A)).forbid_terms, []);
    assert.deepEqual((await read(B)).forbid_terms, []);
  });

  await t("C4 A 에서 writing_format 을 저장하면 A 의 다음 조회가 곧바로 새 형식", async () => {
    assert.equal((await read(A)).enabled, true, "전제: 캐시에 켬이 들어 있다");
    await withTenant(A, () => store.updateRuntimeConfig({ writing_format: { enabled: false } }, "tester", "test"));
    assert.deepEqual(rows.get(A.id), { enabled: false, rules: { local_path: "reject" } }, "배선: DB 원본 위에 patch 가 얹혔다");
    const after = await counted(() => read(A));
    assert.equal(after.v.enabled, false, "저장한 프로세스는 TTL 을 기다리지 않는다");
    assert.equal(after.n, 1);
  });

  await t("C5 A 의 저장 뒤에도 B 는 제 형식 — 무효화가 남의 값을 섞지 않는다", async () => {
    const b = await read(B);
    assert.equal(b.enabled, true);
    assert.equal(b.register, "polite");
    assert.deepEqual(b.apply_to, ["activity"]);
  });

  await t("C6 writing_format 을 안 건드린 저장은 캐시를 비우지 않는다", async () => {
    await read(A);
    await withTenant(A, () => store.updateRuntimeConfig({ hooks: { work_flag: false } }, "tester", "test"));
    const after = await counted(() => read(A));
    assert.equal(after.n, 0, "형식과 무관한 저장이 캐시를 비웠다");
    assert.equal(after.v.enabled, false);
  });

  await t("C7 DB 를 직접 고치면 30초 안에선 옛 값 · 지나면 새 값 · 비우면 곧바로 새 값", async () => {
    forgetAll();
    assert.equal((await read(A)).register, "plain");
    rows.set(A.id, { enabled: false, register: "polite" });   // 다른 게이트웨이 프로세스의 저장
    clock += 29_000;
    assert.equal((await read(A)).register, "plain", "30초 안에선 옛 값(캐시)");
    clock += 2_000;
    assert.equal((await read(A)).register, "polite", "30초가 지나면 새 값");
    rows.set(A.id, { enabled: false, register: "any" });
    assert.equal((await read(A)).register, "polite", "전제: 다시 캐시");
    assert.equal(typeof (store as { invalidateWritingFormatCache?: unknown }).invalidateWritingFormatCache, "function", "직접 고친 쪽이 부를 무효화가 있어야 한다");
    forgetAll();
    assert.equal((await read(A)).register, "any", "비우면 곧바로 새 값");
  });

  await t("C8 조회 실패는 던지지 않는다 — 처음이면 기본값(꺼짐), 읽은 적 있으면 그 워크스페이스의 마지막 값", async () => {
    await read(B);
    clock += 31_000;
    failing = true;
    try {
      const c = await read(C);
      assert.equal(c.enabled, false, "한 번도 못 읽은 워크스페이스는 기본값(꺼짐)");
      const b = await read(B);
      assert.equal(b.register, "polite", "읽은 적 있는 워크스페이스는 제 마지막 값 — 남의 값이나 기본값이 아니다");
      assert.equal(b.enabled, true);
    } finally {
      failing = false;
    }
  });

  await t("C9 받은 형식 객체를 고쳐도 다음 조회는 그대로", async () => {
    forgetAll();
    rows.set(A.id, { enabled: true, apply_to: ["knowledge"], rules: { local_path: "reject" } });
    const f = await read(A);
    f.apply_to.push("project");
    f.rules.local_path = "off";
    f.enabled = false;
    const g = await read(A);
    assert.deepEqual(g.apply_to, ["knowledge"]);
    assert.equal(g.rules.local_path, "reject");
    assert.equal(g.enabled, true);
  });

  console.log(`runtime-config-writing-format(store): ${pass} passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
