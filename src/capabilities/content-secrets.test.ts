// v6 콘텐츠 쓰기 입구의 평문 시크릿 차단 (#4501 결정 2-1 «막기»).
//
// 사양·엣지표: 스크래치패드 spec.md ④. 핵심은 셋이다.
//  ① 사람(웹 REST)·AI(MCP)가 공유하는 입구 핸들러 15곳이 **DB 를 건드리기 전에** 400 으로 거부한다.
//     DB 주소를 비운 채 부르므로, 검사보다 조회가 먼저면 «ITEMS_DATABASE_URL 이 설정되지 않았다» 가 먼저 튄다 — 그러면 실패다.
//  ② 이미 저장된 옛 텍스트를 담는 칸(edit 의 old · description_base)은 보지 않는다 — 시크릿을 **지우는** 편집이 막히면 안 된다.
//  ③ 산문 낱말 속 «sk-» 같은 경계는 막지 않는다(긴 본문에 걸리면 저장 자체가 불가해진다).
//
// 실행: npm run build && node dist/capabilities/content-secrets.test.js
import assert from "node:assert/strict";

delete process.env.ITEMS_DATABASE_URL;   // 정적 import 전에 — client.ts 가 import 시점에 읽는다
const { categoryCapabilities } = await import("./categories.js");
const { projectV6Capabilities } = await import("./projects-v6.js");
const { taskDetailV6Capabilities } = await import("./task-detail-v6.js");
const { listV6Capabilities } = await import("./lists-v6.js");
const { taskFieldV6Capabilities } = await import("./task-field-v6.js");
const { authoringCapabilities } = await import("./knowledge/authoring.js");
const { shellProjectFromPrompt } = await import("../project/first-prompt-project.js");

const all = [...categoryCapabilities, ...projectV6Capabilities, ...taskDetailV6Capabilities, ...listV6Capabilities, ...taskFieldV6Capabilities, ...authoringCapabilities];
const cap = (name: string) => {
  const c = all.find((x) => x.name === name);
  assert.ok(c, `capability ${name} 를 찾지 못했다(테스트가 대상을 잃음)`);
  return c!;
};
const user = { userId: "t-4501", email: "t@x", scopes: ["admin"] } as never;
const ctx = { source: "mcp" } as never;

// 가짜 자격 — 소스에 리터럴로 두지 않는다(시크릿 스캐너가 이 파일을 잡지 않게, 값은 런타임 조립).
const GH = "gh" + "p_" + "A1b2C3d4".repeat(5);
const GHO = "gh" + "o_" + "Z9y8X7w6".repeat(4);
const ANT = "sk" + "-ant-" + "api03-" + "Q".repeat(40);

type Outcome = { blocked: boolean; status?: number; message: string };
const call = async (name: string, input: unknown): Promise<Outcome> => {
  try {
    await cap(name).handler(input as never, user, ctx);
    return { blocked: false, message: "(성공)" };
  } catch (e) {
    const err = e as { status?: number; message?: string };
    const message = String(err?.message ?? e);
    return { blocked: err?.status === 400 && /평문 시크릿/.test(message), status: err?.status, message };
  }
};

let pass = 0;
const t = async (name: string, fn: () => Promise<void> | void): Promise<void> => { await fn(); pass++; console.log(`ok  ${name}`); };

// ── ① 입구 15곳 — 텍스트 칸마다 토큰 → 400 · 칸 경로 · 값 미포함 ──
const ENTRIES: Array<[string, Record<string, unknown>, string]> = [
  ["knowledge_save", { name: "k", title: "t", body_md: `본문 ${GH}`, category: "c", type: "reference" }, "body_md"],
  ["knowledge_set_title", { name: "k", title: `제목 ${GH}` }, "title"],
  ["category_create", { key: "c", name: "n", should: `정의 ${GH}` }, "should"],
  ["category_update", { id: 1, description: `설명 ${GH}` }, "description"],
  ["category_group_upsert", { name: `묶음 ${GH}` }, "name"],
  ["project_create_v6", { name: "p", description: `본문 ${GH}` }, "description"],
  ["project_update_v6", { id: 1, append_description: `덧붙임 ${GH}` }, "append_description"],
  ["project_rename_v6", { id: 1, name: `이름 ${GH}` }, "name"],
  ["task_create_v6", { parent_id: 1, name: "t", description: `본문 ${GH}` }, "description"],
  ["task_update_v6", { id: 2, description: `본문 ${GH}` }, "description"],
  ["task_checklist_v6", { id: 2, op: "add_item", checklist_id: 1, name: `항목 ${GH}` }, "name"],
  ["task_comment_v6", { id: 2, text: `댓글 ${GH}` }, "text"],
  ["project_list_create_v6", { name: `목록 ${GH}` }, "name"],
  ["project_list_update_v6", { id: 1, description: `설명 ${GH}` }, "description"],
  ["task_field_value_set_v6", { taskId: 2, fieldId: 3, value: `값 ${GH}` }, "value"],
];
for (const [name, input, field] of ENTRIES) {
  await t(`E1 ${name} — ${field} 의 토큰을 DB 전에 400 으로 거부한다(칸 경로 O · 값 X)`, async () => {
    const r = await call(name, input);
    assert.ok(r.blocked, `막지 않았다(또는 검사보다 조회가 먼저다): status=${r.status} ${r.message.slice(0, 160)}`);
    assert.match(r.message, new RegExp(`\\b${field}\\b`), `어느 칸인지 말하지 않는다: ${r.message}`);
    assert.ok(!r.message.includes(GH), "오류 메시지에 시크릿 값이 실렸다");
  });
}

// ── 배선 단언 — 토큰이 없으면 이 검사에선 막히지 않는다(DB 가 없어 다른 이유로 실패하는 것은 정상) ──
await t("E0 토큰이 없는 같은 입력은 이 검사에 막히지 않는다(모든 입구)", async () => {
  for (const [name, input] of ENTRIES) {
    const clean = JSON.parse(JSON.stringify(input).split(GH).join("평범한 글"));
    const r = await call(name, clean);
    assert.ok(!r.blocked, `${name}: 토큰이 없는데 시크릿으로 막았다 — ${r.message}`);
  }
});

// ── knowledge_save 모드별 ──
await t("E2 append 조각의 토큰은 400", async () => {
  assert.ok((await call("knowledge_save", { name: "k", mode: "append", body_md: `덧붙임 ${GH}` })).blocked);
});
await t("E3 edit 의 new 에 든 토큰은 400", async () => {
  const r = await call("knowledge_save", { name: "k", mode: "edit", edits: [{ old: "옛 문장", new: `새 문장 ${GH}` }] });
  assert.ok(r.blocked, r.message);
  assert.match(r.message, /edits\.0\.new/);
});
await t("E4 edit 의 old 에만 든 토큰(= 시크릿을 지우는 편집)은 막지 않는다", async () => {
  const r = await call("knowledge_save", { name: "k", mode: "edit", edits: [{ old: `토큰 ${GH}`, new: "(지움)" }] });
  assert.ok(!r.blocked, `지우는 편집을 막았다: ${r.message}`);
});
await t("E5 description_base(옛 본문)에만 든 토큰은 막지 않는다 — project·task 둘 다", async () => {
  for (const name of ["project_update_v6", "task_update_v6"]) {
    const r = await call(name, { id: 1, description: "고친 본문", description_base: `옛 본문 ${GH}` });
    assert.ok(!r.blocked, `${name}: 옛 본문 때문에 막았다 — ${r.message}`);
  }
});

// ── 값 모양 ──
await t("E6 중첩 값(객체·배열 안)의 토큰도 400", async () => {
  const r = await call("task_field_value_set_v6", { taskId: 2, fieldId: 3, value: { rows: [{ note: GH }] } });
  assert.ok(r.blocked, r.message);
  assert.match(r.message, /value\.rows\.0\.note/);
});
await t("E7 새로 넣은 종류 — Anthropic sk-ant-… · GitHub gho_ 도 400", async () => {
  assert.ok((await call("task_comment_v6", { id: 2, text: `키 ${ANT}` })).blocked, "Anthropic 키를 못 막았다");
  assert.ok((await call("task_comment_v6", { id: 2, text: `토큰 ${GHO}` })).blocked, "GitHub OAuth 토큰(gho_)을 못 막았다");
});
await t("E8 경계 — 낱말 안의 «sk-» 는 키가 아니다(긴 산문 저장이 막히지 않게)", async () => {
  const r = await call("task_comment_v6", { id: 2, text: "risk-managementprocedures2026 · task-descriptionupdatelog" });
  assert.ok(!r.blocked, `산문을 키로 오인했다: ${r.message}`);
});
await t("E9 빈 문자열·null·숫자는 검사 대상이 아니다", async () => {
  const r = await call("task_field_value_set_v6", { taskId: 2, fieldId: 3, value: [null, 0, "", { n: 42 }] });
  assert.ok(!r.blocked, r.message);
});

// ── 자동 생성은 막지 않고 가린다 ──
await t("E10 첫 지시에 붙인 토큰은 초안 프로젝트 이름·본문에 남지 않는다(가림)", () => {
  const spec = shellProjectFromPrompt(`${GH} 이 토큰으로 배포 스크립트 고쳐 줘`);
  assert.ok(spec, "초안이 안 만들어졌다 — 막지 말고 가려야 한다");
  assert.ok(!spec!.name.includes(GH) && !spec!.description.includes(GH), "토큰이 초안에 남았다");
  assert.match(spec!.description, /\[REDACTED\]/);
});
await t("E11 평범한 첫 지시는 그대로다(가림이 정상 글을 건드리지 않는다)", () => {
  const spec = shellProjectFromPrompt("임베딩 끄기 스크립트 점검해 줘");
  assert.ok(spec && spec.description.includes("임베딩 끄기 스크립트 점검해 줘") && !spec.description.includes("[REDACTED]"));
});

console.log(`\ncontent-secrets tests: ${pass} passed`);
