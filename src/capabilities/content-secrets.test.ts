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
import { spawnSync } from "node:child_process";

delete process.env.ITEMS_DATABASE_URL;   // 정적 import 전에 — client.ts 가 import 시점에 읽는다
const { categoryCapabilities } = await import("./categories.js");
const { projectV6Capabilities } = await import("./projects-v6.js");
const { taskDetailV6Capabilities } = await import("./task-detail-v6.js");
const { listV6Capabilities } = await import("./lists-v6.js");
const { taskFieldV6Capabilities } = await import("./task-field-v6.js");
const { authoringCapabilities } = await import("./knowledge/authoring.js");
const { wikiUiStaticCapabilities, wikiUiNamedCapabilities } = await import("./knowledge/wiki-ui.js");
const { folderV6Capabilities } = await import("./folders-v6.js");
const { AUTO_CREATED_MARK } = await import("../project/first-prompt-project.js");
const { shellProjectFromPrompt } = await import("../project/first-prompt-project.js");

const all = [...categoryCapabilities, ...projectV6Capabilities, ...taskDetailV6Capabilities, ...listV6Capabilities, ...taskFieldV6Capabilities, ...authoringCapabilities,
  ...wikiUiStaticCapabilities, ...wikiUiNamedCapabilities, ...folderV6Capabilities];
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
const OPROJ = "sk" + "-proj-" + "Ab3_dE-f".repeat(6);
const PKH = "-----BEGIN " + "PRIVATE KEY-----";
const PKB = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC".repeat(2);

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

// ── ① 입구 21곳 — 텍스트 칸마다 토큰 → 400 · 칸 경로 · 값 미포함 ──
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
  // 격리 리뷰가 짚은 빠진 입구 6곳(사람이 쓰는 이름·본문)
  ["knowledge_comment_post", { name: "k", text: `댓글 ${GH}` }, "text"],
  ["task_tags_v6", { id: 2, name: `태그 ${GH}` }, "name"],
  ["task_tag_update_v6", { id: 1, name: `태그 ${GH}` }, "name"],
  ["task_field_create_v6", { projectId: 1, field_type: "text", name: `필드 ${GH}` }, "name"],
  ["task_field_update_v6", { id: 1, name: `필드 ${GH}` }, "name"],
  ["project_folder_create_v6", { name: `폴더 ${GH}` }, "name"],
  ["project_folder_update_v6", { id: 1, name: `폴더 ${GH}` }, "name"],
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

await t("E12 AWS 공식 문서 예시 키(…EXAMPLE)는 막지 않고, 실제 모양의 키는 막는다", async () => {
  const example = "AKIA" + "IOSFODNN7" + "EXAMPLE";
  const real = "AKIA" + "Q3VJ7ZK2M9XW4TPL";
  assert.ok(!(await call("task_comment_v6", { id: 2, text: `문서 예시 ${example}` })).blocked, "AWS 문서 예시 키를 막았다");
  assert.ok((await call("task_comment_v6", { id: 2, text: `키 ${real}` })).blocked, "실제 모양의 AWS 키를 못 막았다");
});
await t("E13 개인키 머리줄만 적은 형식 설명은 막지 않고, 본문이 붙은 키는 막는다", async () => {
  const header = "-----BEGIN " + "OPENSSH PRIVATE KEY-----";
  assert.ok(!(await call("task_comment_v6", { id: 2, text: `파일 첫 줄은 ${header} 이다` })).blocked, "머리줄 설명을 막았다");
  const pem = `${header}\n${"b3BlbnNzaC1rZXktdjEAAAAA".repeat(3)}\n`;
  assert.ok((await call("task_comment_v6", { id: 2, text: pem })).blocked, "본문이 붙은 개인키를 못 막았다");
});

await t("E14 개인키 — JSON 이스케이프(GCP 서비스계정)·암호화 PEM·인용 블록도 400(첫 판이 놓친 모양 — 격리 리뷰)", async () => {
  const shapes = {
    json_escaped: `{"private_key":"${PKH}\\n${PKB}"}`,
    encrypted: `-----BEGIN RSA ${"PRIVATE KEY"}-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,ABCDEF0123\n\n${PKB}`,
    md_quote: `> ${PKH}\n> ${PKB}`,
  };
  for (const [k, text] of Object.entries(shapes)) {
    assert.ok((await call("task_comment_v6", { id: 2, text })).blocked, `${k} 모양의 개인키를 못 막았다`);
  }
});
await t("E15 OpenAI 프로젝트 키(sk-proj-…)도 400", async () => {
  assert.ok((await call("task_comment_v6", { id: 2, text: `키 ${OPROJ}` })).blocked);
});
await t("E16 외부 하네스 첫 지시 자동 생성(AUTO_CREATED_MARK)은 막지 않고 가린다 — 입력이 가려진 채 다음 단계로 간다", async () => {
  const input = { name: `${GH} 배포`, description: `## 첫 지시(원문)\n\n${GH} 로 배포해 줘\n\n${AUTO_CREATED_MARK}` };
  const r = await call("project_create_v6", input);
  assert.ok(!r.blocked, `자동 생성을 막았다(세션 작업면이 안 생긴다): ${r.message}`);
  assert.ok(!input.description.includes(GH) && input.description.includes("[REDACTED]"), "본문이 가려지지 않았다");
  assert.ok(!input.name.includes(GH), "이름이 가려지지 않았다");
  // 표식 없는 같은 입력은 종전대로 400(사람이 쓰는 입구)
  assert.ok((await call("project_create_v6", { name: "p", description: `본문 ${GH}` })).blocked);
});

await t("E17 적대 입력에서도 검사가 선형 시간에 끝난다(ReDoS 방지) — 자식 프로세스 10초 상한", () => {
  //  첫 개인키 식은 «머리줄 + a:a:a:…» 에서 지수 역추적이 났다(n=42 에 308ms, 2자마다 ×4). 한 입구의 문자열 하나로
  //  게이트웨이가 멈추므로, 회귀하면 CI 가 매달리지 않고 이 행이 실패하도록 자식에서 시간을 잰다.
  const REDACT = JSON.stringify(new URL("../org/ingest/redact.js", import.meta.url).href);
  const body = `import { assertNoHardSecrets } from ${REDACT};
    const H = "-----BEGIN " + "PRIVATE KEY-----";
    const hostile = [H + " " + "a:".repeat(5000) + "!", H + "a:\\n".repeat(5000) + "!", H + "a: ".repeat(5000) + "!",
      H + "\\nProc-Type: x".repeat(3000) + "!", H + " ".repeat(100000) + "!", H + ">".repeat(100000) + "!",
      H + "\\\\n".repeat(50000) + "!", H + ("a:" + "A".repeat(39)).repeat(2000) + "!", "sk-ant-" + "a-".repeat(20000) + "!"];
    const t0 = performance.now();
    for (const h of hostile) { try { assertNoHardSecrets(h, "x"); } catch { /* 판정은 상관없다 — 시간만 잰다 */ } }
    console.log("ELAPSED", Math.round(performance.now() - t0));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", body], { encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL" });
  assert.equal(r.signal, null, `적대 입력에서 검사가 10초 안에 안 끝났다(역추적 폭발)\n${r.stderr}`);
  assert.equal(r.status, 0, r.stderr);
  const ms = Number(/ELAPSED (\d+)/.exec(r.stdout)?.[1]);
  assert.ok(Number.isFinite(ms) && ms < 2000, `적대 입력 9종에 ${ms}ms — 선형이면 수십 ms 다`);
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
