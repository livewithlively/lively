// 지식 상세(knowledge_get)의 서술 형식 신호 테스트.
//
//  조직 지시는 «읽은 지식이 형식에 어긋나면 그 자리에서 고쳐라» 인데, 읽기 응답이 문서별 신호를 주지 않으면 에이전트는
//  어긋났는지 알 수 없다. 저장 응답과 같은 판정(면제·fail-open)을 읽기에도 건다.
//  회귀 대상 ①: 고칠 수 없는 글(외부 미러·폴더)이나 형식이 꺼진 조직에 신호가 실리는 것.
//  회귀 대상 ②: 형식 조회·검사 장애로 읽기가 실패하는 것.
//  회귀 대상 ③: 부분읽기가 잘라낸 줄만 판정해 뒤쪽 위반을 놓치는 것.
//  회귀 대상 ④: 사람 확인이 필요한 항목(ask_human)까지 «위반 0건까지 반복» 에 걸리는 것 — 글에 없는 사실이 있어야 고칠 수 있어,
//   안내를 따르는 에이전트가 같은 저장을 되풀이하거나 날짜·경로를 지어낸다.
//  회귀 대상 ⑤: 고칠 수 없거나(쓰기 게이트·주입 문구) 다른 사람이 방금 고친 글에 «지금 고쳐라» 가 실리는 것.
//  회귀 대상 ⑥: 부분읽기에 전문 판정을 실으면서 전문을 읽으라는 말이 없어, 받은 줄 범위만 보고 고치는 것.
//  핸들러 배선(검토 대기 조회 · 쓰기 게이트 · 최근 편집)은 read-get-handler.test.ts 가 핸들러째 돌려 본다.
import assert from "node:assert/strict";
import { readStyleHint, type ReadStyleHint } from "../writing-style.js";
import { knowledgeGetResult } from "./read.js";
import { resolveWritingFormat } from "../../org/policies/writing-format.js";
import type { KnowledgeRow } from "../../v6/knowledge-store.js";

const on = async () => resolveWritingFormat({ enabled: true });
const off = async () => resolveWritingFormat({});
const row = (over: Partial<KnowledgeRow>): KnowledgeRow => ({
  name: "deploy-note", title: "배포 노트 범위", body_md: "노트는 직전 배포 이후 커밋을 싣는다.",
  injection: "recalled", provenance: "authored", lifecycle: "active", confidence: "high", source: "manual",
  summary: null, sort: 0, is_wiki: false, searchable: true, is_folder: false, version: 1, updated_at: "2026-10-01T00:00:00Z", ...over,
});
const BAD = row({ title: "🔴 배포 규칙 (2026-09-23)", body_md: "## 배경\n\n오늘 배포했다." });
// 사람 확인이 필요한 규칙(relative_time)만 걸린 글 — 첫 줄은 결론이고 제목도 맞다.
const ONLY_ASK = row({ body_md: "노트는 직전 배포 이후 커밋을 싣는다.\n오늘 고쳤다." });
type Style = { style?: ReadStyleHint };
const SELF = "직접 고칠 항목", ASK = "사람 확인이 필요한 항목";
/** note 의 묶음(«직접 고칠 항목 N건(a, b)» · «사람 확인이 필요한 항목 N건(c)»)을 읽는다 — 없으면 null. */
const group = (note: string, label: string): { n: number; rules: string[] } | null => {
  const m = note.match(new RegExp(`${label} (\\d+)건\\(([^)]*)\\)`));
  return m ? { n: Number(m[1]), rules: m[2].split(", ") } : null;
};
// «지금 … 고친다» — 지금 고치라는 지시. «지금 고치지 않는다» 는 걸리지 않는다.
const FIX_NOW = /지금 [^.]*고친다/;
let pass = 0;
const failed: string[] = [];
// 실패해도 다음 시험을 계속 돌려 한 번에 다 보인다 — 끝에서 실패가 있으면 종료 코드 1.
const ta = async (name: string, fn: () => Promise<void>): Promise<void> => {
  try {
    await fn();
    pass++;
    console.log(`ok  ${name}`);
  } catch (e) {
    failed.push(name);
    console.log(`FAIL  ${name}\n      ${String((e as Error)?.message ?? e).split("\n").slice(0, 4).join("\n      ")}`);
  }
};

await ta("위반이 있으면 count·findings·note 를 싣고 가이드 전문은 싣지 않는다", async () => {
  const st = ((await readStyleHint(BAD, on)) as Style).style!;
  assert.ok(st.count >= 4, String(st.count));
  assert.equal(st.findings.length, st.count);
  for (const want of ["title_leading_emoji", "title_date", "lead_missing", "relative_time"]) assert.ok(st.findings.some((f) => f.rule === want), want);
  for (const f of st.findings) assert.ok(typeof f.rule === "string" && typeof f.level === "string" && typeof f.message === "string");
  assert.match(st.note, /서술 형식/);
  assert.match(st.note, /mode='edit'/);
  assert.match(st.note, /knowledge_set_title/);
  assert.ok(!("guide_md" in st));
  assert.ok(!("edit_blocked" in st), "고칠 수 있는 글엔 edit_blocked 가 없다");
});
await ta("findings 는 앞 10건까지만 싣고 count 는 전체 건수다 — note 의 묶음은 잘리기 전 전체로 센다", async () => {
  // 위반 14건 표본(규칙마다 1건) — 잘림이 실제로 일어나는지 본다.
  const many = row({
    title: "🔴 " + "가".repeat(70) + " (2026-09-23) !1234 — 정정 — 부제",
    body_md: [
      "## ⚠ 정정", "", "> 폐기: 아래는 옛 내용이다.", "오늘 배포했다 → 확인 → 재배포 → 완료 → 끝.",
      "**a** **b** **c** **d** **e** **f** 🔴 ⚠ ✅ 🔴 ⚠ ✅ 이다.", "/Users/someone/a.md 에 있다.", "괄호(안에 (또 괄호) 있다)다.", "아직 대기 중이다.",
    ].join("\n"),
  });
  const st = ((await readStyleHint(many, on)) as Style).style!;
  assert.ok(st.count > 10, String(st.count));
  assert.equal(st.findings.length, 10);
  // 잘린 뒤쪽 규칙도 note 에서 빠지지 않는다 — 저장 응답에 남은 규칙을 어느 묶음인지 알아보려면 전부 있어야 한다.
  const self = group(st.note, SELF), ask = group(st.note, ASK);
  assert.ok(self && ask, st.note);
  assert.equal(self.n + ask.n, st.count, st.note);
  assert.equal(new Set([...self.rules, ...ask.rules]).size, st.count, st.note);
});
await ta("위반이 없거나 형식이 꺼져 있으면 아무것도 싣지 않는다(빈 객체도 아니다)", async () => {
  assert.deepEqual(await readStyleHint(row({}), on), {});
  assert.deepEqual(await readStyleHint(BAD, off), {});
});
await ta("외부 미러와 폴더는 판정하지 않는다", async () => {
  let loaded = 0;
  const counted = async () => { loaded++; return on(); };
  assert.deepEqual(await readStyleHint({ ...BAD, provenance: "observed" }, counted), {});
  assert.deepEqual(await readStyleHint({ ...BAD, is_folder: true }, counted), {});
  assert.equal(loaded, 0, "면제면 형식도 읽지 않는다");
});
await ta("형식 조회가 실패하면 신호 없이 끝난다(throw 하지 않는다)", async () => {
  const boom = async (): Promise<never> => { throw new Error("db down"); };
  assert.deepEqual(await readStyleHint(BAD, boom), {});
});
await ta("판정이 터져도 신호 없이 끝난다", async () => {
  // lint 내부 구현과 무관하게 터뜨린다 — 형식 객체의 어떤 속성이든 읽는 순간 throw.
  let touched = 0;
  const broken = async () => new Proxy({} as Awaited<ReturnType<typeof on>>, {
    get: () => { touched++; throw new Error("format broken"); },
  });
  assert.deepEqual(await readStyleHint(BAD, broken), {});
  assert.ok(touched > 0, "판정이 형식 객체를 읽어 catch 경로를 탔어야 한다");
});
await ta("보관·대체된 지식은 판정하지 않는다", async () => {
  let loaded = 0;
  const counted = async () => { loaded++; return on(); };
  assert.deepEqual(await readStyleHint({ ...BAD, lifecycle: "archived" }, counted), {});
  assert.deepEqual(await readStyleHint({ ...BAD, lifecycle: "superseded" }, counted), {});
  assert.equal(loaded, 0, "보관·대체면 형식도 읽지 않는다");
  assert.ok(((await readStyleHint({ ...BAD, lifecycle: "pending" }, on)) as Style).style, "pending 은 판정한다");
});

// ── 다음 행동(note) — 직접 고칠 항목과 사람 확인 항목을 가르고, 반복에 끝을 둔다 ──
await ta("직접 고칠 항목과 사람 확인 항목을 나눠 적고, 반복은 직접 고칠 항목에만 건다", async () => {
  const st = ((await readStyleHint(BAD, on)) as Style).style!;
  const self = group(st.note, SELF), ask = group(st.note, ASK);
  assert.ok(self && ask, st.note);
  assert.deepEqual(new Set(ask.rules), new Set(st.findings.filter((f) => f.ask_human === true).map((f) => f.rule)), st.note);
  assert.deepEqual(new Set(self.rules), new Set(st.findings.filter((f) => f.ask_human !== true).map((f) => f.rule)), st.note);
  assert.match(st.note, FIX_NOW);
  // 멈춤 조건 — 사람 확인 항목만 남으면 멈추고 묻는다. 같은 규칙은 한 번 더까지만 고친다.
  assert.match(st.note, /사람 확인이 필요한 항목만 남으면 멈추고 사람에게 묻는다/);
  assert.match(st.note, /한 번 더 고치고, 같은 규칙이 그래도 남으면 더 고치지 않고 멈춘다/);
  assert.doesNotMatch(st.note, /0건\)? ?(이 될 때까지|까지)|더는 실리지 않을 때까지/, "위반 0건까지 반복하라고 하면 ask_human 이 남은 글에서 끝나지 않는다");
  assert.match(st.note, /지어내지/);
});
await ta("사람 확인 항목만 있으면 «지금 고친다» 를 싣지 않고, 지어내지 말고 사람에게 묻게 한다", async () => {
  const st = ((await readStyleHint(ONLY_ASK, on)) as Style).style!;
  assert.ok(st.findings.length > 0 && st.findings.every((f) => f.ask_human === true), JSON.stringify(st.findings));
  assert.ok(group(st.note, ASK), st.note);
  assert.equal(group(st.note, SELF), null, st.note);
  assert.doesNotMatch(st.note, FIX_NOW);
  assert.doesNotMatch(st.note, /한 번 더/);
  assert.match(st.note, /사람에게/);
  assert.match(st.note, /지어내지/);
  assert.ok(!("edit_blocked" in st), "고칠 수는 있는 글이다 — 사람의 답이 있어야 할 뿐");
});
await ta("제목 규칙이 없으면 knowledge_set_title 을 말하지 않는다", async () => {
  const st = ((await readStyleHint(row({ body_md: "## 배경\n\n노트는 커밋을 싣는다." }), on)) as Style).style!;
  assert.deepEqual(st.findings.map((f) => f.rule), ["lead_missing"]);
  assert.match(st.note, FIX_NOW);
  assert.doesNotMatch(st.note, /knowledge_set_title/);
});

// ── 고치면 안 되는 글 — findings 는 싣되 고치라고 하지 않는다 ──
for (const why of ["no_write", "recently_edited"] as const) {
  await ta(`고칠 수 없거나 고치면 안 되는 글(${why})이면 findings 는 싣되 고치라고 하지 않는다`, async () => {
    const st = ((await readStyleHint(BAD, on, { editBlock: async () => why })) as Style).style!;
    assert.equal(st.edit_blocked, why);
    assert.ok(st.count >= 4 && st.findings.length === st.count, JSON.stringify(st));
    assert.match(st.note, /지금 고치지 않는다/);
    assert.doesNotMatch(st.note, FIX_NOW);
    assert.doesNotMatch(st.note, /mode='edit'|knowledge_set_title|한 번 더/);
    if (why === "recently_edited") assert.match(st.note, /다른 사람이 최근 24시간 안에 고친 글/);
  });
}
await ta("세션 주입 문구(injection='always')는 누가 읽어도 고치라고 하지 않고, 쓰기 판정도 묻지 않는다", async () => {
  let asked = 0;
  const st = ((await readStyleHint({ ...BAD, injection: "always" }, on, { editBlock: async () => { asked++; return null; } })) as Style).style!;
  assert.equal(st.edit_blocked, "injected");
  assert.match(st.note, /세션 주입 문구/);
  assert.match(st.note, /지금 고치지 않는다/);
  assert.doesNotMatch(st.note, /mode='edit'/);
  assert.doesNotMatch(st.note, FIX_NOW);
  assert.equal(asked, 0, "행만 보고 가른다");
});
await ta("고쳐도 되는지는 위반이 있을 때만 묻고, 그 판정이 터지면 고치라고 하지 않는다(읽기는 그대로)", async () => {
  let asked = 0;
  const count = async () => { asked++; return null; };
  assert.deepEqual(await readStyleHint(row({}), on, { editBlock: count }), {});
  assert.deepEqual(await readStyleHint(BAD, off, { editBlock: count }), {});
  assert.equal(asked, 0, "위반이 없으면 쓰기 게이트를 묻지 않는다");
  const st = ((await readStyleHint(BAD, on, { editBlock: async () => { throw new Error("db down"); } })) as Style).style!;
  assert.equal(st.edit_blocked, "no_write");
  assert.doesNotMatch(st.note, /mode='edit'/);
});

// ── 부분읽기 — 판정은 전문 기준이라 고치기 전에 전문을 읽게 한다 ──
await ta("부분읽기면 판정이 본문 전체 기준이고 고치기 전에 전문을 읽으라고 한다 — 전문을 읽었으면 그 말은 없다", async () => {
  const part = ((await readStyleHint(BAD, on, { partial: true })) as Style).style!;
  assert.match(part.note, /본문 전체 기준/);
  assert.match(part.note, /offset·limit 없이 전문을 읽는다/);
  const askPart = ((await readStyleHint(ONLY_ASK, on, { partial: true })) as Style).style!;
  assert.match(askPart.note, /offset·limit 없이 전문을 읽는다/);
  const full = ((await readStyleHint(BAD, on)) as Style).style!;
  assert.doesNotMatch(full.note, /offset|본문 전체 기준/);
});

// 상세 응답 조립 — 핸들러가 DB 에서 읽은 뒤의 모양.
await ta("상세 응답에 style 이 실리고, 위반이 없으면 키 자체가 없다", async () => {
  const r = await knowledgeGetResult(BAD, {}, {}, { staged: false }, on) as Style & { knowledge: KnowledgeRow };
  assert.equal(r.knowledge.name, "deploy-note");
  assert.ok(r.style && r.style.count > 0);
  const clean = await knowledgeGetResult(row({}), {}, {}, { staged: false }, on);
  assert.ok(!("style" in clean), JSON.stringify(Object.keys(clean)));
});
await ta("상세 응답은 고쳐도 되는지 판정(editBlock)을 형식 신호에 넘긴다", async () => {
  const r = await knowledgeGetResult(BAD, {}, {}, { staged: false, editBlock: async () => "recently_edited" }, on) as Style;
  assert.equal(r.style?.edit_blocked, "recently_edited", JSON.stringify(r.style));
});
await ta("형식 조회가 실패해도 상세 응답은 그대로 나간다", async () => {
  const boom = async (): Promise<never> => { throw new Error("db down"); };
  const r = await knowledgeGetResult(BAD, {}, { pending_revision: { id: 1 } }, { staged: false }, boom) as Record<string, unknown>;
  assert.ok(r.knowledge && r.pending_revision);
  assert.ok(!("style" in r));
});
await ta("검토 대기 중인 수정 제안(staged)이 있으면 싣지 않는다(edit 가 막혀 안내를 따를 수 없다)", async () => {
  let loaded = 0, asked = 0;
  const counted = async () => { loaded++; return on(); };
  const staged = await knowledgeGetResult(BAD, {}, { pending_revision: { id: 1, mode: "staged" } },
    { staged: true, editBlock: async () => { asked++; return null; } }, counted);
  assert.ok(!("style" in staged));
  assert.equal(loaded, 0, "staged 면 형식도 읽지 않는다");
  assert.equal(asked, 0, "staged 면 쓰기 판정도 묻지 않는다");
  const review = await knowledgeGetResult(BAD, {}, { pending_revision: { id: 1, mode: "applied" } }, { staged: false }, on) as Style;
  assert.ok(review.style && review.style.count > 0, "staged 가 아닌 대기는 edit 가 막히지 않는다");
});
await ta("부분읽기도 잘라낸 줄이 아니라 본문 전체를 판정하고, 고치기 전에 전문을 읽으라고 한다", async () => {
  // 위반(상대시간)은 맨 끝 줄에만 있다. 앞 2줄만 읽어도 신호가 실려야 한다.
  const body = ["노트는 직전 배포 이후 커밋을 싣는다.", ...Array.from({ length: 30 }, (_, i) => `항목 ${i + 1} 을 싣는다.`), "오늘 고쳤다."].join("\n");
  const r = await knowledgeGetResult(row({ body_md: body }), { offset: 1, limit: 2 }, {}, { staged: false }, on) as Style & { knowledge: KnowledgeRow; body_range: { returned: number } };
  assert.equal(r.body_range.returned, 2);
  assert.doesNotMatch(r.knowledge.body_md, /오늘/);
  assert.ok(r.style?.findings.some((f) => f.rule === "relative_time"), JSON.stringify(r.style));
  assert.match(r.style!.note, /offset·limit 없이 전문을 읽는다/);
  // limit 만 줘도 부분읽기다.
  const lim = await knowledgeGetResult(row({ body_md: body }), { limit: 5 }, {}, { staged: false }, on) as Style;
  assert.match(lim.style!.note, /본문 전체 기준/);
});
await ta("사실이 필요한 규칙에도 고치는 법(fix)을 싣는다 — 홈 경로는 서버가 처리해 사람 확인을 빼고, 이미 있던 줄의 기준 날짜는 근거(anchors)로 싣되 사람 확인으로 남긴다", async () => {
  const body = ["## 배포", "", "오늘 배포했다 → 확인 → 끝.", "/Users/someone/a.md 에 있다.", "아직 대기 중이다."].join("\n");
  const anchorsOf = async () => [
    { line: "오늘 배포했다 → 확인 → 끝.", rules: ["relative_time" as const], date: "2026-09-04", basis: "first_version" as const },
    { line: "아직 대기 중이다.", rules: ["undated_status" as const], date: "2026-09-05", basis: "first_version" as const },
  ];
  const st = ((await readStyleHint(row({ title: "🔴 배포 규칙", body_md: body }), on, { anchorsOf })) as Style).style!;
  const byRule = new Map<string, any>(st.findings.map((f) => [f.rule as string, f as typeof f & { fix?: string; anchors?: Array<{ date: string; hint: string }> }]));
  for (const r of ["relative_time", "local_path", "undated_status"]) assert.ok(byRule.get(r)?.fix, `${r} 에 고치는 법이 있다: ${JSON.stringify(st.findings)}`);
  assert.ok(!("ask_human" in (byRule.get("local_path") ?? {})), "local_path 에 ask_human 이 없다");
  // 읽기의 줄은 모두 이미 있던 줄이다 — 기록상 처음 저장된 날은 근거로 싣되, 옮겨 온 글·가져온 문서면 쓴 날과 달라 사람에게 확인한다.
  for (const r of ["relative_time", "undated_status"]) assert.equal(byRule.get(r)?.ask_human, true, `${r} 는 근거를 들고 사람에게 묻는다: ${JSON.stringify(st.findings)}`);
  assert.equal(byRule.get("relative_time")?.anchors?.[0].date, "2026-09-04");
  assert.match(byRule.get("relative_time")!.anchors![0].hint, /2026-09-03/, "어제는 기준 날짜 하루 전");
  assert.equal(byRule.get("undated_status")?.anchors?.[0].date, "2026-09-05");
  assert.match(st.note, /사람에게 묻/);
  // 배너를 옮길지는 정정이 본문에 반영됐는지에 달린 판단이라 사람에게 묻는다.
  const banner = ((await readStyleHint(row({ body_md: "노트는 커밋을 싣는다.\n\n## ⚠ 정정\n\n범위를 바꿨다." }), on, { anchorsOf })) as Style).style!;
  assert.equal((banner.findings.find((f) => f.rule === "revision_banner") as { ask_human?: true } | undefined)?.ask_human, true, JSON.stringify(banner.findings));
  const long = ((await readStyleHint(row({ body_md: "노트는 커밋을 싣는다.\n" + "가".repeat(30000) }), on)) as Style).style!;
  // 본문 길이는 어디서 나눌지가 사실 판단이라 사람에게 묻는다.
  assert.ok(long.findings.some((f) => f.rule === "body_length" && f.ask_human === true), JSON.stringify(long.findings));
});
await ta("기준 날짜 조회 자체가 실패하면 읽기는 되고 시점 위반은 사람 확인(ask_human)으로 남는다 — 날짜를 지어내지 않게", async () => {
  const st = ((await readStyleHint(row({ body_md: "노트는 커밋을 싣는다.\n오늘 고쳤다." }), on, { anchorsOf: async () => { throw new Error("db down"); } })) as Style).style!;
  const rel = st.findings.find((f) => f.rule === "relative_time") as { fix?: string; anchors?: unknown; ask_human?: true } | undefined;
  assert.ok(rel?.ask_human && !rel.fix && !rel.anchors, JSON.stringify(rel));
  assert.match(st.note, /사람에게 묻/);
});
await ta("고칠 수 있으면 style_fix·expected_version 을 함께 보내라고 한다 — 서버가 사실 보존과 그 사이 다른 저장을 대조한다(#1740)", async () => {
  const st = ((await readStyleHint(BAD, on)) as Style).style!;
  assert.match(st.note, /style_fix:true/);
  assert.match(st.note, /expected_version/);
});
console.log(`read-style: ${pass} passed${failed.length ? `, ${failed.length} failed` : ""}`);
if (failed.length) process.exit(1);
