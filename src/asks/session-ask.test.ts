// 순수 단위 체크(node:assert · DB 없음) — 세션 요청(#5713)의 종류 등록부 · 종류별 판정 · 도구 표면.
//
//  세션 요청 = 세션의 AI 가 사람에게 화면으로 받는 것(값 입력 · 고르기 · 파일 올리기). 종전엔 리브 전용(me_liv_ask_*)이었다.
//  자격 종류의 안전 경계(어디에 넣어도 되나 · 저장된 대상만 쓴다)는 org/delivery/liv-secret.test.ts 가 그대로 지킨다 — 여기는 그 밖이다.
//
// 사양 엣지표(행마다 시나리오 하나 이상):
//  | #   | 상태                                                        | 기대                                             |
//  |-----|-------------------------------------------------------------|--------------------------------------------------|
//  | R1  | 내장 종류 등록(두 번 불러도)                                   | secret · choice · upload — 순서 그대로 · 한 번만    |
//  | R2  | 같은 종류 · 같은 도구 이름 · 옛 이름과 겹치는 도구 이름을 다시 등록 | 던진다(조용히 덮지 않는다) · 거절된 것은 안 남는다    |
//  | R3  | 종류 이름 형식 위반(빈 값 · 대문자 · 숫자 시작 · 33자)           | 던진다                                            |
//  | S1  | 종류마다 도구                                                 | session_ask_<종류> — MCP 열림 · POST /api/ui/me/asks/open/<종류> |
//  | S2  | 옛 이름(me_liv_ask_*)                                        | 같은 핸들러 · 같은 입력 · 옛 REST 경로              |
//  | S3  | 화면 전용 문(list · get · submit · dismiss · tell)             | MCP 닫힘(AI 가 제 요청에 스스로 답하지 못한다)        |
//  | S4  | 읽기/쓰기 갈래                                                | status · list · get 은 읽기 · 나머지는 쓰기          |
//  | S5  | 인증 없는 호출                                                | 401 — 저장소에 닿기 전에                            |
//  | S6  | 걸기 — 검증 거절                                              | 저장소에 닿기 전에 400(검증이 저장보다 먼저)          |
//  | S7  | 요청 id 형식 위반 · 읽기전용 세션의 내리기                      | 400 · 403 — 저장소에 닿기 전에                      |
//  | S8  | 앱 principal                                                 | session_ask_* 전부 거절(앱 맥락 범위 밖)             |
//  | S9  | 도구 입력 모양                                                | 평평한 zod shape                                  |
//  | C1  | 객관식 — question 없음 / 선택지 1개 / id 중복 / id·key 형식 위반 | 400                                              |
//  | C2  | 객관식 — key 없음(새로 선택이 된 값이 **빈 경우**)               | 허용 · payload 에 key 가 없다                      |
//  | C3  | 객관식 — 경계: 선택지 12/13개 · 글 길이 상한                    | 12개까지 · 길이로 자른다 · 정확히 2개는 허용         |
//  | C4  | 답 — 목록 밖 id                                               | 버린다(남은 게 없으면 400)                          |
//  | C5  | 답 — 단일 선택에 둘 / 선택지 + 직접 적기                        | 400                                              |
//  | C6  | 답 — allow_other 가 아닌데 other                               | other 를 읽지 않는다                               |
//  | C7  | 답 — 복수 선택 + other                                        | choices(보낸 순서) · labels(선택지 순서) · other 200자 |
//  | C8  | 답 — 같은 id 두 번                                            | 한 번으로                                         |
//  | C9  | 같은 key(없으면 같은 질문) 다시 묻기                            | slot 이 같다 · 다른 질문은 다르다                   |
//  | C10 | 답의 say · result(key 없는 질문)                               | 질문 + 고른 것 · 저장소에 안 닿는다                  |
//  | C11 | key 있는 질문 — 집계 쓰기 성공 / 실패 / 거절된 답 / key 없음       | 한 번 쌓는다(by:self) / 그래도 답은 받는다 / 안 쌓는다 / 안 쌓는다 |
//  | U1  | 올리기 — 파일 0개 / 이름 빈 것만                                | 400                                              |
//  | U2  | 올리기 — 경계: 50/51개 · source_id 가 0·음수·문자·소수           | 50개까지 · source_id 는 양의 정수만                 |
//  | U3  | 올리기 — say: 10개 이하 / 11개 이상                             | 개수 · 이름(자료 id) · 넘으면 줄임표                 |
//  | U4  | 올리기 — 못 올린 것 있음 / 없음(0 · 음수 · 글자 · 생략)            | 있으면 몇 개인지 말한다 · 없으면 말하지 않는다        |
//  | V1  | 바깥 모양(askView) — 아는 종류 / 모르는 종류 / 빈 payload        | 종류 이름 · 제목 · payload 그대로 · 안 던진다        |
//  | V2  | 요청 주소                                                     | #/ask/<id>                                        |
import assert from "node:assert/strict";
import { z } from "zod";
import { registerAskKind, askKind, type AskKind } from "./kinds.js";
import { registerBuiltinAskKinds, askKinds } from "./kinds/index.js";
import { choiceAskPayload, choiceAnswer, choiceAskKind, choiceDeps } from "./kinds/choice.js";
import { uploadedFiles, uploadAskKind } from "./kinds/upload.js";
import { sessionAskCapabilities, askView, askHash } from "../capabilities/session-ask.js";
import { capMutates } from "../capabilities/index.js";
import { appContextUnsafeWhy } from "../apps/app-context.js";
import type { Capability } from "../capabilities/types.js";
import type { AskRow } from "./store.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };
const ta = async (name: string, fn: () => Promise<void>): Promise<void> => { await fn(); pass++; console.log(`ok  ${name}`); };
const status = (e: unknown): number | undefined => (e as { status?: number })?.status;
const throws400 = (fn: () => unknown, label: string): void => { assert.throws(fn, (e: unknown) => status(e) === 400, label); };

registerBuiltinAskKinds();
const cap = (name: string): Capability => {
  const c = sessionAskCapabilities.find((x) => x.name === name);
  assert.ok(c, `도구가 없다: ${name}`);
  return c;
};
const restOf = (c: Capability): string[] => (Array.isArray(c.expose.rest) ? c.expose.rest : []).flatMap((m) => m.paths.map((p) => `${m.method} ${p}`));
const user = { userId: "u1", email: "u1@example.invalid", scopes: [], projects: ["*"] } as never;

// ── 등록부 ──────────────────────────────────────────────────────────────────────────
t("[R1] 내장 종류 셋 — 값 입력 · 고르기 · 파일 올리기(등록 순서 = 도구 목록 순서) · 두 번 불러도 한 번만", () => {
  assert.deepEqual(askKinds().map((k) => k.kind), ["secret", "choice", "upload"]);
  registerBuiltinAskKinds();
  assert.equal(askKinds().length, 3);
  assert.equal(askKind("choice"), choiceAskKind);
  assert.equal(askKind("nope"), undefined);
});

t("[R2] 겹치는 등록은 던진다 — 종류 이름 · 도구 이름 · 옛 이름과 겹치는 도구 이름 · 거절된 것은 남지 않는다", () => {
  const base: AskKind = { ...uploadAskKind, kind: "tmp_kind", tool: { ...uploadAskKind.tool, name: "session_ask_tmp" }, aliases: [] };
  assert.throws(() => registerAskKind({ ...base, kind: "upload" }));
  assert.throws(() => registerAskKind({ ...base, tool: { ...base.tool, name: "session_ask_choice" } }));
  assert.throws(() => registerAskKind({ ...base, tool: { ...base.tool, name: "me_liv_ask_secret" } }));
  assert.throws(() => registerAskKind({ ...base, aliases: [{ name: "session_ask_upload", title: "x", restPath: "/x" }] }));
  assert.equal(askKind("tmp_kind"), undefined, "거절된 등록이 남았다");
  assert.equal(askKinds().length, 3);
});

t("[R3] 종류 이름 형식 — 소문자로 시작하는 슬러그 32자까지", () => {
  for (const bad of ["", "Upload", "1abc", "a-b", "a b", "x".repeat(33)]) {
    assert.throws(() => registerAskKind({ ...uploadAskKind, kind: bad, tool: { ...uploadAskKind.tool, name: "session_ask_x_" + bad.length }, aliases: [] }),
      Error, `형식 위반이 통과했다: ${JSON.stringify(bad)}`);
  }
  assert.equal(askKinds().length, 3);
});

// ── 표면 ────────────────────────────────────────────────────────────────────────────
t("[S1] 종류마다 거는 도구 하나 — session_ask_<종류> · MCP 열림 · POST /api/ui/me/asks/open/<종류> · cancel 로 내린다", () => {
  for (const k of askKinds()) {
    const c = cap(k.tool.name);
    assert.equal(c.name, `session_ask_${k.kind}`);
    assert.equal(c.expose.mcp, true, `${c.name} 이 MCP 에 없다 — AI 가 쓰라고 만든 도구다`);
    assert.deepEqual(restOf(c), [`POST /api/ui/me/asks/open/${k.kind}`]);
    assert.equal(c.scope, null);
    assert.ok("cancel" in c.input, `${c.name} 에 cancel 이 없다(걸어 둔 요청을 내릴 길)`);
  }
});

t("[S2] 옛 이름(me_liv_ask_*) — 같은 핸들러 · 같은 입력 · 옛 REST 경로(이미 심긴 스킬·훅이 깨지지 않게)", () => {
  const legacy: Record<string, [string, string]> = {
    me_liv_ask_secret: ["session_ask_secret", "POST /api/ui/me/liv-secret-ask"],
    me_liv_ask_choice: ["session_ask_choice", "POST /api/ui/me/liv-choice-ask"],
    me_liv_ask_upload: ["session_ask_upload", "POST /api/ui/me/liv-upload-ask"],
  };
  for (const [old, [now, rest]] of Object.entries(legacy)) {
    const a = cap(old), b = cap(now);
    assert.equal(a.handler, b.handler, `${old} 의 핸들러가 ${now} 와 다르다(판정이 두 벌)`);
    assert.equal(a.input, b.input);
    assert.equal(a.expose.mcp, true);
    assert.deepEqual(restOf(a), [rest]);
    assert.ok(a.description.includes(now), "옛 이름의 설명이 새 이름을 가리키지 않는다");
  }
});

t("[S3] 화면 전용 문 — list · get · submit · dismiss · tell 은 MCP 에 없다(AI 가 제 요청에 스스로 답하지 못한다)", () => {
  const web: Record<string, string> = {
    session_ask_list: "GET /api/ui/me/asks",
    session_ask_get: "GET /api/ui/me/asks/item/:id",
    session_ask_submit: "POST /api/ui/me/asks/item/:id/submit",
    session_ask_dismiss: "POST /api/ui/me/asks/item/:id/dismiss",
    session_ask_tell: "POST /api/ui/me/asks/item/:id/tell",
  };
  for (const [name, rest] of Object.entries(web)) {
    const c = cap(name);
    assert.equal(c.expose.mcp, false, `★ ${name} 이 MCP 로 열렸다 — AI 가 사람 대신 답하거나 값을 넣을 수 있다`);
    assert.deepEqual(restOf(c), [rest]);
  }
  //  이 표면의 도구는 위 다섯 + 종류 셋 + 옛 이름 셋 + 상태 조회 하나가 전부다 — 여기 없는 문이 MCP 로 새지 않았나.
  assert.equal(sessionAskCapabilities.length, 5 + 3 + 3 + 1);
  const mcp = sessionAskCapabilities.filter((c) => c.expose.mcp).map((c) => c.name).sort();
  assert.deepEqual(mcp, ["me_liv_ask_choice", "me_liv_ask_secret", "me_liv_ask_upload", "session_ask_choice", "session_ask_secret", "session_ask_status", "session_ask_upload"]);
});

t("[S4] 읽기/쓰기 — 상태 조회 · 목록 · 하나 보기는 읽기(읽기전용 세션도 본다) · 걸기 · 답하기 · 접기 · 알리기는 쓰기", () => {
  for (const r of ["session_ask_status", "session_ask_list", "session_ask_get"]) assert.equal(capMutates(cap(r)), false, `${r} 이 쓰기로 읽힌다`);
  for (const w of ["session_ask_secret", "session_ask_choice", "session_ask_upload", "me_liv_ask_secret", "session_ask_submit", "session_ask_dismiss", "session_ask_tell"]) {
    assert.equal(capMutates(cap(w)), true, `${w} 이 읽기로 읽힌다 — 읽기전용 세션에서 열린다`);
  }
});

await ta("[S5] 인증 없는 호출은 401 — 저장소에 닿기 전에", async () => {
  for (const c of sessionAskCapabilities) {
    await assert.rejects(() => c.handler({ id: "ask_aaaaaaaaaaaaaaaa", question: "q", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] }, {} as never) as Promise<unknown>,
      (e: unknown) => status(e) === 401, `${c.name} 이 인증 없이 지나갔다`);
  }
});

await ta("[S6] 걸기 — 검증 거절은 저장보다 먼저다(거절되면 아무것도 남지 않는다 — 저장소 없이도 400 이 난다)", async () => {
  const choice = cap("session_ask_choice");
  await assert.rejects(() => choice.handler({ question: "", options: [] }, user) as Promise<unknown>, (e: unknown) => status(e) === 400);
  await assert.rejects(() => choice.handler({ question: "Q", options: [{ id: "a", label: "A" }] }, user) as Promise<unknown>, (e: unknown) => status(e) === 400);
  const secret = cap("session_ask_secret");
  await assert.rejects(() => secret.handler({ label: "x" }, user) as Promise<unknown>, (e: unknown) => status(e) === 400, "넣을 자리 없음");
  await assert.rejects(() => secret.handler({ collector_id: 1, field: "token", vault_kind: "slack_bot_token" }, user) as Promise<unknown>, (e: unknown) => status(e) === 400, "넣을 자리 둘");
});

await ta("[S7] 요청 id 형식 위반은 400 · 읽기전용 세션의 내리기는 403 — 저장소에 닿기 전에", async () => {
  for (const name of ["session_ask_get", "session_ask_submit", "session_ask_dismiss", "session_ask_tell"]) {
    for (const bad of ["", "a", "ask 1", "../x", "ask_" + "x".repeat(80), "ask;drop"]) {
      await assert.rejects(() => cap(name).handler({ id: bad }, user) as Promise<unknown>, (e: unknown) => status(e) === 400, `${name} 이 id ${JSON.stringify(bad)} 를 받았다`);
    }
  }
  await assert.rejects(() => cap("session_ask_status").handler({ id: "bad id" }, user) as Promise<unknown>, (e: unknown) => status(e) === 400);
  await assert.rejects(() => cap("session_ask_status").handler({ id: "ask_aaaaaaaaaaaaaaaa", cancel: true }, user, { readOnly: true }) as Promise<unknown>,
    (e: unknown) => status(e) === 403, "읽기전용 세션이 요청을 내렸다");
});

t("[S8] 앱 principal 에는 session_ask_* 가 전부 닫혀 있다 — 구성원 화면에 입력칸을 띄워 그 사람 금고에 값을 받는 문이다", () => {
  for (const c of sessionAskCapabilities) {
    assert.ok((appContextUnsafeWhy(c.name) ?? "").length > 0, `★ 앱 맥락에서 열려 있다: ${c.name}`);
  }
});

t("[S9] 도구 입력은 평평한 zod shape — tools/list 에 빈 스키마가 실리지 않는다", () => {
  for (const c of sessionAskCapabilities) {
    for (const [k, v] of Object.entries(c.input)) assert.ok(v instanceof z.ZodType, `${c.name}.${k} 가 zod 가 아니다`);
    assert.doesNotThrow(() => z.object(c.input));
  }
});

// ── 객관식 ──────────────────────────────────────────────────────────────────────────
const two = [{ id: "a", label: "A" }, { id: "b", label: "B" }];

t("[C1] 객관식 걸기 거절 — question 없음 · 선택지 1개 · id 중복 · id 형식 · key 형식 · label 없음", () => {
  throws400(() => choiceAskPayload({ options: two }), "question 없음");
  throws400(() => choiceAskPayload({ question: "   ", options: two }), "question 공백");
  throws400(() => choiceAskPayload({ question: "Q", options: [two[0]] }), "선택지 1개");
  throws400(() => choiceAskPayload({ question: "Q" }), "선택지 없음");
  throws400(() => choiceAskPayload({ question: "Q", options: [two[0], { id: "a", label: "또 A" }] }), "id 중복");
  throws400(() => choiceAskPayload({ question: "Q", options: [two[0], { id: "B B", label: "B" }] }), "id 형식");
  throws400(() => choiceAskPayload({ question: "Q", options: [two[0], { id: "b", label: " " }] }), "label 없음");
  throws400(() => choiceAskPayload({ question: "Q", key: "Bad Key", options: two }), "key 형식");
});

t("[C2] key 는 선택이다 — 없으면(빈 값 · 공백) 통계 축 없이 묻는다(payload 에 key 가 없다)", () => {
  for (const none of [undefined, "", "   "]) {
    const p = choiceAskPayload({ question: "A 안과 B 안 중 어느 쪽으로 할까요?", key: none, options: two });
    assert.equal("key" in p, false, `key ${JSON.stringify(none)} 가 payload 에 실렸다`);
    assert.equal(p.kind, "choice");
    assert.equal(p.multi, false);
    assert.equal(p.allow_other, false);
  }
  assert.equal(choiceAskPayload({ question: "Q", key: " context_sources ", options: two }).key, "context_sources");
});

t("[C3] 경계 — 선택지 정확히 2개 허용 · 12개 그대로 · 13개는 12개로 · 질문 300자 · 라벨 80자 · hint 120자 · why 300자", () => {
  assert.equal(choiceAskPayload({ question: "Q", options: two }).options.length, 2);
  const mk = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `o${i}`, label: "L".repeat(200), hint: "h".repeat(300) }));
  assert.equal(choiceAskPayload({ question: "Q", options: mk(12) }).options.length, 12);
  const p = choiceAskPayload({ question: "Q".repeat(500), why: "w".repeat(500), options: mk(13) });
  assert.equal(p.options.length, 12);
  assert.equal(p.question.length, 300);
  assert.equal(p.why?.length, 300);
  assert.equal(p.options[0].label.length, 80);
  assert.equal(p.options[0].hint?.length, 120);
  assert.equal("hint" in choiceAskPayload({ question: "Q", options: two }).options[0], false, "빈 hint 는 싣지 않는다");
});

const single = choiceAskPayload({ question: "Q", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }, { id: "c", label: "C" }] });
const multi = choiceAskPayload({ question: "Q", multi: true, allow_other: true, options: single.options });
const singleOther = choiceAskPayload({ question: "Q", allow_other: true, options: single.options });

t("[C4] 답 — 목록 밖 id 는 버린다(브라우저가 임의 값을 넣지 못한다) · 남은 게 없으면 400", () => {
  assert.deepEqual(choiceAnswer(multi, { choices: ["a", "zzz", "c"] }).choices, ["a", "c"]);
  throws400(() => choiceAnswer(single, { choices: ["zzz"] }), "전부 목록 밖");
  throws400(() => choiceAnswer(single, {}), "아무것도 없음");
  throws400(() => choiceAnswer(single, { choices: "a" }), "배열이 아님");
});

t("[C5] 답 — 단일 선택은 답이 하나다: 둘을 고르거나 선택지 + 직접 적기는 400", () => {
  throws400(() => choiceAnswer(single, { choices: ["a", "b"] }), "둘");
  throws400(() => choiceAnswer(singleOther, { choices: ["a"], other: "카카오톡" }), "선택지 + 직접 적기");
  assert.deepEqual(choiceAnswer(singleOther, { choices: [], other: "카카오톡" }), { choices: [], labels: [], other: "카카오톡" });
  assert.deepEqual(choiceAnswer(single, { choices: ["b"] }), { choices: ["b"], labels: ["B"] });
});

t("[C6] 답 — allow_other 가 아닌 질문의 other 는 읽지 않는다", () => {
  throws400(() => choiceAnswer(single, { other: "몰래 적은 것" }), "other 만");
  assert.deepEqual(choiceAnswer(single, { choices: ["a"], other: "몰래 적은 것" }), { choices: ["a"], labels: ["A"] });
});

t("[C7] 답 — 복수 선택 + other: choices 는 보낸 순서 · labels 는 선택지 순서 · other 는 200자", () => {
  const a = choiceAnswer(multi, { choices: ["c", "a"], other: " 네이버 밴드 " });
  assert.deepEqual(a.choices, ["c", "a"]);
  assert.deepEqual(a.labels, ["A", "C"]);
  assert.equal(a.other, "네이버 밴드");
  assert.equal(choiceAnswer(multi, { other: "x".repeat(500) }).other?.length, 200);
});

t("[C8] 답 — 같은 id 두 번은 한 번으로(집계가 부풀지 않는다 · 단일 선택에서 «둘» 로 읽히지 않는다)", () => {
  assert.deepEqual(choiceAnswer(multi, { choices: ["a", "a", "b"] }).choices, ["a", "b"]);
  assert.deepEqual(choiceAnswer(single, { choices: ["a", "a"] }).choices, ["a"]);
});

await ta("[C9] 같은 key(없으면 같은 질문)를 다시 물으면 slot 이 같다 — 앞 요청을 갈아 끼운다 · 다른 질문은 다르다", async () => {
  const who = { userId: "u1", user, session: "box-a" };
  const k1 = await choiceAskKind.open({ key: "context_sources", question: "어디에 쌓아 두셨어요?", options: two }, who);
  const k2 = await choiceAskKind.open({ key: "context_sources", question: "문구를 다듬은 같은 질문", options: two }, who);
  assert.equal(k1.slot, k2.slot);
  const q1 = await choiceAskKind.open({ question: "A 안 / B 안?", options: two }, who);
  const q2 = await choiceAskKind.open({ question: "A 안 / B 안?", options: two }, who);
  const q3 = await choiceAskKind.open({ question: "다른 질문?", options: two }, who);
  assert.ok(q1.slot, "key 없는 질문의 slot 이 비었다 — 서로 다른 질문이 한 칸을 다툰다");
  assert.equal(q1.slot, q2.slot);
  assert.notEqual(q1.slot, q3.slot);
  assert.notEqual(q1.slot, k1.slot);
  assert.equal(choiceAskKind.title(q1.payload), "A 안 / B 안?");
});

await ta("[C10] 답의 say — 무엇을 물었고 무엇을 골랐는지(AI 가 그것만 보고 이어 간다) · key 없는 질문은 저장소 없이 끝난다", async () => {
  const who = { userId: "u1", user, session: "box-a" };
  const row = { id: "ask_x", member_id: "u1", session_id: "box-a", kind: "choice", slot: "", status: "open", result: null, created_at: "", resolved_at: null,
    payload: multi as unknown as Record<string, unknown> } as AskRow;
  const out = await choiceAskKind.submit(row, { choices: ["a"], other: "카카오톡" }, who);
  assert.equal(out.say, "«Q» — A, 카카오톡");
  assert.deepEqual(out.result, { choices: ["a"], labels: ["A"], other: "카카오톡" });
  await assert.rejects(() => choiceAskKind.submit(row, { choices: ["zzz"] }, who), (e: unknown) => status(e) === 400, "목록 밖 답이 받아들여졌다");
});

await ta("[C11] 통계 축(key)이 있는 질문 — 답을 집계에 한 번 쌓는다(by:self) · 집계 쓰기가 실패해도 답은 받는다 · key 없으면 안 쌓는다", async () => {
  const who = { userId: "u1", user, session: "box-a" };
  const keyed = choiceAskPayload({ key: "context_sources", question: "어디에 쌓아 두셨어요?", multi: true, allow_other: true, options: single.options });
  const row = (payload: unknown) => ({ id: "ask_k", member_id: "u1", session_id: "box-a", kind: "choice", slot: "", status: "open", result: null, created_at: "", resolved_at: null,
    payload: payload as Record<string, unknown> } as AskRow);
  const real = choiceDeps.appendAnswer;
  try {
    const seen: Array<[string, Record<string, unknown>]> = [];
    choiceDeps.appendAnswer = async (u, a) => { seen.push([u, a as unknown as Record<string, unknown>]); };
    const out = await choiceAskKind.submit(row(keyed), { choices: ["b", "a"], other: "카카오톡" }, who);
    assert.equal(seen.length, 1, "집계에 한 번 쌓는다");
    assert.equal(seen[0][0], "u1");
    assert.deepEqual({ ...seen[0][1], at: "" }, { at: "", key: "context_sources", question: "어디에 쌓아 두셨어요?", choices: ["b", "a"], other: "카카오톡", by: "self" });
    assert.deepEqual(out.result, { key: "context_sources", choices: ["b", "a"], labels: ["A", "B"], other: "카카오톡" });
    //  거절된 답은 집계에 닿지 않는다(검증이 먼저다).
    await assert.rejects(() => choiceAskKind.submit(row(keyed), { choices: ["zzz"] }, who), (e: unknown) => status(e) === 400);
    assert.equal(seen.length, 1, "거절된 답이 집계에 쌓였다");
    //  key 없는 질문은 집계에 쌓지 않는다.
    await choiceAskKind.submit(row(multi), { choices: ["a"] }, who);
    assert.equal(seen.length, 1, "key 없는 질문이 집계에 쌓였다");
    //  집계 쓰기가 던져도(구성원 행이 없는 토큰 등) 답은 받는다 — 던지면 사람은 오류를 보고 요청이 열린 채 남는다.
    choiceDeps.appendAnswer = async () => { throw new Error("구성원 정보를 찾을 수 없습니다"); };
    const still = await choiceAskKind.submit(row(keyed), { choices: ["a"] }, who);
    assert.deepEqual(still.result, { key: "context_sources", choices: ["a"], labels: ["A"] });
    assert.equal(still.say, "«어디에 쌓아 두셨어요?» — A");
  } finally { choiceDeps.appendAnswer = real; }
});

// ── 파일 올리기 ─────────────────────────────────────────────────────────────────────
t("[U1] 올린 것이 없으면 400 — 파일 0개 · 이름이 빈 것만", () => {
  throws400(() => uploadedFiles({}), "files 없음");
  throws400(() => uploadedFiles({ files: [] }), "빈 배열");
  throws400(() => uploadedFiles({ files: [{ name: "  " }, {}] }), "이름 빈 것만");
});

t("[U2] 경계 — 50개 그대로 · 51개는 50개로 · 이름 200자 · source_id 는 양의 정수만", () => {
  const mk = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `f${i}.md`, source_id: i + 1 }));
  assert.equal(uploadedFiles({ files: mk(50) }).length, 50);
  assert.equal(uploadedFiles({ files: mk(51) }).length, 50);
  assert.deepEqual(uploadedFiles({ files: [{ name: "a.md", source_id: 0 }, { name: "b.md", source_id: -3 }, { name: "c.md", source_id: "x" }, { name: "d.md", source_id: 7 }, { name: "e.md", source_id: 1.5 }, { name: "f.md", source_id: 1 }] }),
    [{ name: "a.md" }, { name: "b.md" }, { name: "c.md" }, { name: "d.md", source_id: 7 }, { name: "e.md" }, { name: "f.md", source_id: 1 }]);
  assert.equal(uploadedFiles({ files: [{ name: "n".repeat(500) }] })[0].name.length, 200);
});

await ta("[U3] 올리기의 say · result — 개수 · 이름(자료 id) · 10개는 그대로 · 11개부터 줄임표", async () => {
  const who = { userId: "u1", user, session: null };
  const row = { id: "ask_u", member_id: "u1", session_id: null, kind: "upload", slot: "", status: "open", result: null, created_at: "", resolved_at: null, payload: {} } as AskRow;
  const out = await uploadAskKind.submit(row, { files: [{ name: "회의록.md", source_id: 12 }, { name: "메모.txt" }] }, who);
  assert.equal(out.say, "파일 2개 올렸어요: 회의록.md(자료 12), 메모.txt");
  assert.deepEqual(out.result, { count: 2, files: [{ name: "회의록.md", source_id: 12 }, { name: "메모.txt" }] });
  const names = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `f${i}.md` }));
  const ten = await uploadAskKind.submit(row, { files: names(10) }, who);
  assert.ok(String(ten.say).endsWith("f9.md"), `10개인데 줄였다: ${ten.say}`);
  const eleven = await uploadAskKind.submit(row, { files: names(11) }, who);
  assert.ok(String(eleven.say).startsWith("파일 11개 올렸어요: f0.md, ") && String(eleven.say).endsWith("f9.md …") && !String(eleven.say).includes("f10.md"), `11개의 say: ${eleven.say}`);
  assert.equal((eleven.result as { count: number }).count, 11, "줄인 것은 말뿐이다 — 결과에는 전부 있다");
  //  U4 — 못 올린 것이 있으면 몇 개인지도 전한다. 개수는 양의 정수만 센다(0 · 음수 · 글자 · 없음은 «다 올라갔다» 와 같은 말).
  const part = await uploadAskKind.submit(row, { files: [{ name: "a.md" }], failed: 2, skipped: 1 }, who);
  assert.equal(part.say, "파일 1개 올렸어요: a.md (고른 것 중 3개는 올리지 못했어요)");
  assert.deepEqual(part.result, { count: 1, files: [{ name: "a.md" }], failed: 2, skipped: 1 });
  for (const none of [{}, { failed: 0, skipped: 0 }, { failed: -2 }, { failed: "x", skipped: 1.5 }]) {
    const clean = await uploadAskKind.submit(row, { files: [{ name: "a.md" }], ...none }, who);
    assert.equal(clean.say, "파일 1개 올렸어요: a.md", `못 올린 것이 없는데 말했다: ${JSON.stringify(none)}`);
    assert.deepEqual(clean.result, { count: 1, files: [{ name: "a.md" }] });
  }
  assert.equal(uploadAskKind.title((await uploadAskKind.open({}, who)).payload), "파일 올리기");
  assert.equal((await uploadAskKind.open({ label: " 회의록 파일 " }, who)).slot, "label:회의록 파일");
});

// ── 바깥 모양 ───────────────────────────────────────────────────────────────────────
t("[V1] askView — 종류 이름 · 제목 · payload 그대로 · 모르는 종류 · 빈 payload 에도 던지지 않는다", () => {
  const row = (kind: string, payload: Record<string, unknown>): AskRow => ({ id: "ask_v", member_id: "u1", session_id: "box-a", kind, slot: "", payload, status: "open", result: null, created_at: "2026-11-23T00:00:00.000Z", resolved_at: null });
  const v = askView(row("secret", { label: "GitLab 토큰", dest: "…" }));
  assert.equal(v.kind_label, "값 입력");
  assert.equal(v.title, "GitLab 토큰");
  assert.deepEqual(v.payload, { label: "GitLab 토큰", dest: "…" });
  assert.equal(v.session_id, "box-a");
  assert.equal("member_id" in v, false, "요청한 사람 id 를 싣지 않는다(본인 것만 보이는 표면이다)");
  const u = askView(row("future_kind", { x: 1 }));
  assert.equal(u.kind_label, "future_kind");
  assert.equal(u.title, "future_kind");
  assert.equal(askView(row("choice", {})).title, "고르기", "제목 재료가 없으면 종류 이름");
});

t("[V2] 요청 주소 — #/ask/<id>(화면 web/v2/ask-page.ts askHash 와 한 벌)", () => {
  assert.equal(askHash("ask_AbC-12_x"), "#/ask/ask_AbC-12_x");
});

console.log(`\n${pass} 통과`);
