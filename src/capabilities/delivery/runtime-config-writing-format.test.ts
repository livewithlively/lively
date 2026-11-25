// org_runtime_update 의 writing_format 입력 검사 — REST 와 MCP 가 같은 판정을 하는가(2026-10-14 리뷰 F).
//  실행: npm run build && node dist/capabilities/delivery/runtime-config-writing-format.test.js
//  실 DB 없이: itemsPool.query 를 페이크로 바꿔 «저장(INSERT)이 나갔나 · 무엇이 저장됐나» 로만 단언한다.
//
//  회귀 대상: REST 는 zod 를 거치지 않아 모양(객체/null)만 봤다 — apply_to:"knowledge" · forbid_terms:"X" 가 200 으로 저장되고
//   [] 로 접혀, 형식을 적용할 표면이 전부 꺼지거나 금지어 목록이 지워졌다.
//
//  엣지 표(입력 조합 × 기대):
//   F1 | 배열 칸에 문자열(apply_to · forbid_terms)                          | 400 · 저장 안 함
//   F2 | 모르는 표면 · 규칙 id · 수준                                         | 400 · 저장 안 함
//   F3 | 한도 범위 밖(title_max_chars 5) · 정수 아님(bold_max 2.5) · 배열     | 400
//   F4 | 타입 틀림(enabled "yes" · guide_md 42 · forbid_terms 원소 숫자 · register/default_level 모르는 값) | 400
//   F5 | 객체가 아님("on" · [])                                              | 400(종전에도 400)
//   F6 | 올바른 patch(표면 · 금지어 · 규칙 · 한도 null 되돌림)                 | 저장 — 준 칸 그대로
//   F7 | null(기본값 복귀) · apply_to: [](표면 전부 끔 — 의도된 값)            | 저장
//   F8 | 같은 입력에 MCP 입력 스키마도 같은 판정(한 객체를 쓴다)               | REST 400 ⇔ MCP 거부
//   F9 | 400 메시지가 틀린 칸을 짚는다                                        | writing_format.apply_to 등
import assert from "node:assert/strict";
import { z } from "zod";
import { itemsPool } from "../../db/client.js";
import type { LivelyUser } from "../../context.js";
import type { CapabilityCtx } from "../types.js";
import { runtimeConfigCapabilities } from "./runtime-config.js";

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

// 페이크 DB — org_runtime_config 한 행의 writing_format 만 흉내 낸다(나머지 읽기는 빈 표 = 기본값).
let stored: unknown = undefined;
let inserts = 0;
(itemsPool as unknown as { query: unknown }).query = async (sql: string, params: unknown[] = []) => {
  const s = String(sql);
  if (/^\s*INSERT INTO org_runtime_config\(/.test(s)) {
    stored = JSON.parse(String(columnParam(s, params, "writing_format")));
    inserts++;
    return { rows: [], rowCount: 1 };
  }
  if (/^\s*SELECT writing_format FROM org_runtime_config/.test(s)) {
    return { rows: stored === undefined ? [] : [{ writing_format: stored }], rowCount: stored === undefined ? 0 : 1 };
  }
  return { rows: [], rowCount: 0 };
};

const cap = runtimeConfigCapabilities.find((c) => c.name === "org_runtime_update");
assert.ok(cap, "org_runtime_update 가 있어야 한다");
const admin = { userId: "admin-1", email: "admin@example.com", scopes: ["admin"], projects: ["*"], tokenSource: "session" } as LivelyUser;
const save = (wf: unknown) => cap.handler({ writing_format: wf }, admin, { source: "web" } as CapabilityCtx);
const errOf = async (p: Promise<unknown>): Promise<(Error & { status?: number }) | null> => {
  try { await p; return null; } catch (e) { return e as Error & { status?: number }; }
};
const mcp = z.object(cap.input as z.ZodRawShape);

let pass = 0;
const t = async (name: string, fn: () => Promise<void> | void): Promise<void> => { await fn(); pass++; console.log(`ok  ${name}`); };

const BAD: Array<[string, unknown, RegExp]> = [
  ["F1 apply_to 가 문자열", { apply_to: "knowledge" }, /writing_format\.apply_to/],
  ["F1 forbid_terms 가 문자열", { forbid_terms: "X" }, /writing_format\.forbid_terms/],
  ["F2 모르는 표면", { apply_to: ["knowledge", "wiki"] }, /writing_format\.apply_to\.1/],
  ["F2 모르는 수준", { rules: { local_path: "block" } }, /writing_format\.rules\.local_path/],
  ["F2 모르는 규칙 id", { rules: { no_such_rule: "reject" } }, /writing_format\.rules/],
  ["F3 한도 범위 밖", { limits: { title_max_chars: 5 } }, /writing_format\.limits\.title_max_chars/],
  ["F3 한도가 정수 아님", { limits: { bold_max: 2.5 } }, /writing_format\.limits\.bold_max/],
  ["F3 limits 가 배열", { limits: [60] }, /writing_format\.limits/],
  ["F4 enabled 가 문자열", { enabled: "yes" }, /writing_format\.enabled/],
  ["F4 register 모르는 값", { register: "loud" }, /writing_format\.register/],
  ["F4 default_level 모르는 값", { default_level: "panic" }, /writing_format\.default_level/],
  ["F4 guide_md 가 숫자", { guide_md: 42 }, /writing_format\.guide_md/],
  ["F4 forbid_terms 원소가 숫자", { forbid_terms: ["ok", 3] }, /writing_format\.forbid_terms\.1/],
  ["F5 객체가 아님(문자열)", "on", /writing_format/],
  ["F5 객체가 아님(배열)", [], /writing_format/],
];

async function main(): Promise<void> {
  for (const [label, wf, where] of BAD) {
    await t(`${label} → 400 · 저장 안 함 · 틀린 칸을 짚는다(F9)`, async () => {
      stored = { enabled: true, apply_to: ["knowledge", "activity"], forbid_terms: ["keep-me"] };
      const before = JSON.stringify(stored);
      const n0 = inserts;
      const e = await errOf(save(wf));
      assert.equal(e?.status, 400, `400 이어야 한다 — 실제: ${e ? `${e.status} ${e.message}` : `200 · 저장된 원본 ${JSON.stringify(stored)}`}`);
      assert.equal(inserts, n0, "거절된 저장은 INSERT 를 내지 않는다");
      assert.equal(JSON.stringify(stored), before, "조직의 기존 형식이 그대로다");
      assert.match(String(e?.message), where);
    });
    await t(`${label} → MCP 입력 스키마도 거부(F8)`, () => {
      assert.equal(mcp.safeParse({ writing_format: wf }).success, false);
    });
  }

  await t("F6 올바른 patch 는 준 칸 그대로 저장 — 한도 null 은 그 칸을 기본값으로", async () => {
    stored = undefined;
    const wf = { enabled: true, apply_to: ["knowledge"], forbid_terms: ["X"], rules: { local_path: "reject" }, limits: { title_max_chars: null, bold_max: 5 } };
    assert.equal(mcp.safeParse({ writing_format: wf }).success, true, "MCP 도 받는다(F8)");
    const n0 = inserts;
    await save(wf);
    assert.equal(inserts, n0 + 1);
    assert.deepEqual(stored, { enabled: true, apply_to: ["knowledge"], forbid_terms: ["X"], rules: { local_path: "reject" }, limits: { bold_max: 5 } });
  });

  await t("F7 apply_to: [] 는 «표면 전부 끔» 이라는 의도된 값 — 저장된다", async () => {
    stored = { enabled: true };
    assert.equal(mcp.safeParse({ writing_format: { apply_to: [] } }).success, true);
    await save({ apply_to: [] });
    assert.deepEqual(stored, { enabled: true, apply_to: [] });
  });

  await t("F7 null 은 제품 기본값으로 되돌림 — 원본을 비운다", async () => {
    stored = { enabled: true, forbid_terms: ["X"] };
    assert.equal(mcp.safeParse({ writing_format: null }).success, true);
    await save(null);
    assert.deepEqual(stored, {});
  });

  console.log(`runtime-config-writing-format: ${pass} passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
