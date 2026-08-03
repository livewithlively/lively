// #1442 소프트캡 — 조정 함수의 행위(A)와 **스키마 계약의 회귀 고정**(B).
//  실행: npm run build && node dist/capabilities/soft-cap.test.js
//
//  B 가 이 파일의 핵심이다: "본문 50,000자와 함께 보낸 호출이 제목 201자 하나로 통째로 거부되고, 재시도에
//  그 본문을 다시 실어야 한다"가 #1442 였다. 그 거부는 우리 핸들러가 아니라 **MCP SDK 가 핸들러 앞에서**
//  z.object(cap.input) 로 하므로(validateToolInput), 여기서도 같은 방식으로 스키마를 직접 태워 검증한다 —
//  핸들러를 부르지 않고도 그 계약이 지켜지는지 볼 수 있는 유일한 지점이고, DB 도 필요 없다.
//  누가 이 필드들에 .max() 를 되붙이면 B 가 즉시 red 가 된다(R5a 가드와 이중 방어선).
import assert from "node:assert/strict";
import { z } from "zod";
import { applySoftCaps, softCapHint, SOFT_CAPS, HARD_CAP_OK, HEAVY_PAYLOAD_CHARS, type SoftCapSpec } from "./soft-cap.js";
import { registry } from "./index.js";

let pass = 0;
const t = (name: string, fn: () => void | Promise<void>): Promise<void> =>
  Promise.resolve(fn()).then(() => { pass++; });

const spec = (limit: number, policy: SoftCapSpec["policy"]): SoftCapSpec => ({ limit, policy, effect: "조정했습니다." });
const CLAMP5 = { f: spec(5, "clamp") };

// ── A. 조정 함수 — 보고만 보지 않고 **조정 뒤 실제 값**을 본다(관측 장치가 죽으면 통과하면서 아무것도 못 본다) ──

await t("A1 상한 미만 — 값 무변경 · 조각 없음", () => {
  const input: Record<string, unknown> = { f: "abc" };
  assert.deepEqual(applySoftCaps("t", input, CLAMP5), {});
  assert.equal(input.f, "abc");
});

await t("A2 경계: 길이가 상한과 같으면 초과가 아니다 — 무변경 · 조각 없음", () => {
  const input: Record<string, unknown> = { f: "abcde" };
  assert.deepEqual(applySoftCaps("t", input, CLAMP5), {});
  assert.equal(input.f, "abcde");
});

await t("A3 경계: 상한+1 → 상한 길이로 잘리고, **보낸 길이**가 보고된다", () => {
  const input: Record<string, unknown> = { f: "abcdef" };
  const out = applySoftCaps("t", input, CLAMP5) as { capped: Record<string, { limit: number; was: number; policy: string }> };
  assert.equal(input.f, "abcde");                       // 실제로 잘렸다
  assert.equal((input.f as string).length, 5);
  assert.deepEqual(out.capped.f.was, 6);                // 조정 전 길이가 남는다(상한이 아니라 보낸 값)
  assert.equal(out.capped.f.limit, 5);
  assert.equal(out.capped.f.policy, "clamp");
});

await t("A4 drop — 초과하면 그 키가 입력에서 사라진다(잘린 참조를 남기지 않는다)", () => {
  const input: Record<string, unknown> = { f: "abcdef", keep: "x" };
  const out = applySoftCaps("t", input, { f: spec(5, "drop") }) as { capped: Record<string, unknown> };
  assert.equal("f" in input, false);                    // 값이 아니라 키 자체가 없다
  assert.equal(input.keep, "x");                        // 다른 필드는 건드리지 않는다
  assert.ok(out.capped.f);
});

await t("A5 note — 값은 그대로 남고 보고만 된다(데이터 층이 정규화할 값)", () => {
  const input: Record<string, unknown> = { f: "abcdef" };
  const out = applySoftCaps("t", input, { f: spec(5, "note") }) as { capped: Record<string, { was: number }> };
  assert.equal(input.f, "abcdef");                      // 손대지 않았다
  assert.equal(out.capped.f.was, 6);
});

await t("A6 필드 부재 — 무변경 · 조각 없음", () => {
  const input: Record<string, unknown> = { other: "y" };
  assert.deepEqual(applySoftCaps("t", input, CLAMP5), {});
  assert.deepEqual(input, { other: "y" });
});

await t("A7 문자열이 아닌 값은 다루지 않는다(숫자·null·객체·배열 — 길이 개념이 다르다)", () => {
  for (const v of [123456789, null, { a: 1 }, ["a", "b", "c", "d", "e", "f"]]) {
    const input: Record<string, unknown> = { f: v };
    assert.deepEqual(applySoftCaps("t", input, CLAMP5), {});
    assert.deepEqual(input.f, v);
  }
});

await t("A8 여러 필드 동시 초과(정책 혼합) — 각자 정책대로 전부 적용되고 전부 보고된다", () => {
  const input: Record<string, unknown> = { a: "aaaaaa", b: "bbbbbb", c: "cccccc" };
  const out = applySoftCaps("t", input, {
    a: spec(5, "clamp"), b: spec(5, "drop"), c: spec(5, "note"),
  }) as { capped: Record<string, unknown>; capped_note: string };
  assert.equal(input.a, "aaaaa");
  assert.equal("b" in input, false);
  assert.equal(input.c, "cccccc");
  assert.deepEqual(Object.keys(out.capped).sort(), ["a", "b", "c"]);
  for (const f of ["a", "b", "c"]) assert.match(out.capped_note, new RegExp(f));
});

await t("A9 선언 표가 비면 아무 것도 하지 않는다(표를 새로 도입했는데 비었을 때)", () => {
  const input: Record<string, unknown> = { f: "아주아주 긴 값" };
  assert.deepEqual(applySoftCaps("t", input, {}), {});
  assert.equal(input.f, "아주아주 긴 값");
});

await t("A10 조정 보고는 필드별 상세 + 사람이 읽는 한 문장이고, 그 문장은 **재전송을 금지**한다", () => {
  const input: Record<string, unknown> = { f: "abcdef" };
  const out = applySoftCaps("t", input, { f: { limit: 5, policy: "clamp", effect: "앞부분만 남겼습니다." } }) as
    { capped: Record<string, { effect: string }>; capped_note: string };
  assert.equal(out.capped.f.effect, "앞부분만 남겼습니다.");
  assert.match(out.capped_note, /다시 보내지 마세요/);   // 재시도를 막는 지시가 반드시 있어야 한다
  assert.match(out.capped_note, /6/);                    // 보낸 길이
  assert.match(out.capped_note, /5/);                    // 상한
});

await t("A11 빈 문자열은 초과가 아니다", () => {
  const input: Record<string, unknown> = { f: "" };
  assert.deepEqual(applySoftCaps("t", input, CLAMP5), {});
  assert.equal(input.f, "");
});

await t("A(배선) 조정이 없으면 응답에 얹을 키가 하나도 없다 — spread 해도 기존 응답이 오염되지 않는다", () => {
  assert.deepEqual(Object.keys(applySoftCaps("t", { f: "ok" }, CLAMP5)), []);
});

await t("A(안내문) softCapHint 는 상한과 초과 시 동작을 정책별로 달리 말한다", () => {
  assert.match(softCapHint(spec(200, "clamp")), /200자 이내/);
  assert.match(softCapHint(spec(200, "clamp")), /자른다/);
  assert.match(softCapHint(spec(64, "drop")), /무시한다/);
  assert.match(softCapHint(spec(64, "note")), /슬러그/);
  for (const p of ["clamp", "drop", "note"] as const) {
    assert.match(softCapHint(spec(9, p)), /실패하지 않으니/);   // 예방 문구의 핵심 — 재시도를 막는다
  }
});

// ── B. 스키마 계약 회귀 — SDK 가 핸들러 앞에서 하는 그 검증을 그대로 태운다 ──
//  변경 전 코드에서는 아래 전부가 "거부"였다(그래서 본문을 다시 실어 재시도해야 했다).

const shapeOf = (tool: string): z.ZodRawShape => {
  const cap = [...registry.values()].find((c) => c.name === tool);
  assert.ok(cap, `${tool} capability 가 있어야 한다`);
  return cap!.input as z.ZodRawShape;
};
const BODY = "본문".repeat(25_000);   // 50,000자 ≈ 12k 토큰 — 재전송 비용이 곧 이 프로젝트의 문제였다
const K_BASE = { body_md: BODY, category: "canonical-context-store", type: "reference" as const };

await t("B1 knowledge_save: 본문 50,000자 + 제목 201자 → 통과(그리고 그 제목이 핸들러까지 온다)", async () => {
  const r = await z.object(shapeOf("knowledge_save")).safeParseAsync({ ...K_BASE, title: "가".repeat(201) });
  assert.equal(r.success, true, "제목 길이로 본문 전체가 튕기면 #1442 재발이다");
  if (!r.success) return;
  const data = r.data as Record<string, string>;
  assert.equal(data.title.length, 201);              // 조정은 핸들러 몫 — 스키마는 그대로 통과시킨다
  assert.equal(data.body_md.length, BODY.length);    // 본문이 온전히 핸들러까지 도달한다
});

await t("B2 knowledge_save: name·supersedes·parent_name 65자 / change_note 601자 → 각각 통과", async () => {
  for (const [f, n] of [["name", 65], ["supersedes", 65], ["parent_name", 65], ["change_note", 601]] as const) {
    const r = await z.object(shapeOf("knowledge_save")).safeParseAsync({ ...K_BASE, title: "짧은 제목", [f]: "a".repeat(n) });
    assert.equal(r.success, true, `${f} ${n}자가 본문 전체를 튕기면 #1442 재발이다`);
  }
});

await t("B3 source_save: title 201자 · name 65자 → 통과", async () => {
  const r = await z.object(shapeOf("source_save")).safeParseAsync({
    body_md: BODY, title: "가".repeat(201), name: "a".repeat(65),
  });
  assert.equal(r.success, true);
});

await t("B4 activity_log: title 501자 · summary 121자 → 통과", async () => {
  const r = await z.object(shapeOf("activity_log")).safeParseAsync({
    type: "feature", body: "x".repeat(20_000), title: "가".repeat(501), summary: "나".repeat(121),
  });
  assert.equal(r.success, true);
});

await t("B5 activity_log: title 은 여전히 **필수**다 — 상한만 뗐고 최소 조건은 그대로(빈 값은 거부)", async () => {
  const shape = z.object(shapeOf("activity_log"));
  assert.equal((await shape.safeParseAsync({ type: "feature", title: "" })).success, false);
  assert.equal((await shape.safeParseAsync({ type: "feature" })).success, false);
  assert.equal((await shape.safeParseAsync({ type: "feature", title: "제목" })).success, true);
});

await t("B(배선) 선언 표의 모든 툴이 실재하고, 조정 대상 필드가 실제 스키마에 있다", () => {
  const names = new Set([...registry.values()].map((c) => c.name));
  for (const tool of [...Object.keys(SOFT_CAPS), ...Object.keys(HARD_CAP_OK)]) {
    assert.ok(names.has(tool), `${tool} 이 registry 에 없다 — 죽은 선언`);
  }
  for (const [tool, specs] of Object.entries(SOFT_CAPS)) {
    const shape = shapeOf(tool);
    for (const f of Object.keys(specs)) assert.ok(f in shape, `${tool}.${f} 가 스키마에 없다`);
  }
  assert.ok(HEAVY_PAYLOAD_CHARS > 0);
});

console.log(`ok  #1442 소프트캡 — 조정 행위 + 스키마 계약 회귀 ${pass}건`);
