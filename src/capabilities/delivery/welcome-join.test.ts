// 초대로 들어온 사람(합류자)의 처음 설정 — 서버 쪽 가드 (#1631, 원준 결정 2026-09-13 §9·§11)
//
//  결정 원문 요지:
//   ② 합류자 판정은 인원수가 아니라 «초대로 들어왔나». 매니지드는 계정 서버가 안다.
//   ④ 합류자가 올린 로컬 파일은 팀원 모두가 보는 팀 자료로 넣고, 그걸로 수집기·카테고리·증류기를 바꾸지 않는다.
//   ⑤ 합류자에게는 리브를 띄우지 않는다.
//
//  엣지 표 → 테스트:
//   M1 매니지드 · 저장값 없음 · CP 가 invite 를 줌        → is_join=true · existing_account=CP 값 · 한 번 저장
//   M2 매니지드 · 저장값 있음                             → CP 를 부르지 않고 그 값을 쓴다
//   M3 매니지드 · CP 실패(502·시간 초과)                   → 저장하지 않음 · 인원수 폴백 · existing_account=null
//   M4 매니지드 · CP 대상 없음(null)                      → 저장하지 않음 · 인원수 폴백
//   M5 매니지드 · CP 응답 모양이 계약과 다름                → 저장하지 않음 · 인원수 폴백
//   M6 매니지드 · CP 가 creator 를 줌 · 사람이 여럿        → 인원수와 무관하게 합류자가 아니다
//   S1 셀프호스트 · 등록부가 판정(비 primary)              → owner 면 creator, 아니면 invite · existing_account=다른 워크스페이스 완료 여부
//   S2 셀프호스트 · primary(등록부 판정 없음)              → 인원수 폴백 · existing_account 는 그대로 계산
//   A1 반영 — 합류자면 갈래·증류기·레인·묶음·리브 킥오프를 부르지 않는다(판정은 서버가 스스로)
//   A3 반영 — 합류자의 용도 답은 워크스페이스 용도가 되지 않는다 · 합류자 칸엔 지금의 용도를 적는다(원준 결정 2026-09-14)
//   U1 업로드 — «팀원 모두» 옵션은 자기 개인 루트 업로드에만 먹고, 기본값은 올린 사람만이다
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { JoinFactDeps } from "./welcome.js";

//  판정 함수는 **동적으로** 읽는다 — 정적 import 면 함수가 없는 판(고치기 전 코드)에서 파일이 통째로 링크 실패해
//   아래 배선 검사까지 한 건도 안 돌고, 어느 행이 빨간불인지 가를 수 없다(fail-first 기록이 뭉개진다).
const resolveJoinFact = async (d: JoinFactDeps) =>
  ((await import("./welcome.js")) as unknown as { resolveJoinFact: (d: JoinFactDeps) => Promise<{ is_join: boolean; via: string | null; existing_account: boolean | null }> }).resolveJoinFact(d);

const read = (rel: string): string =>
  readFileSync(new URL(rel, import.meta.url).pathname.replace("/dist/", "/src/"), "utf8");
//  주석 줄은 뺀다 — 주석에 옛 식·함수 이름이 남아 있어도 그건 동작이 아니다.
const strip = (s: string): string => s.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

/** head 에서 시작하는 블록을 괄호 짝으로 잘라 온다 — 못 찾으면 검사가 헛돌지 않게 그 자리에서 실패한다. */
function blockFrom(src: string, head: string): string {
  const at = src.indexOf(head);
  assert.ok(at >= 0, `${head} 를 못 찾았다 — 검사가 헛돈다`);
  const open = src.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(at, i + 1);
  }
  assert.fail(`${head} 의 닫는 괄호를 못 찾았다`);
}

// ── 합류 사실 판정(순수 — 의존은 주입) ──────────────────────────────────────────
const INVITE = { ok: true, is_creator: false, joined_via: "invite", account_existed: true };
function fake(over: Partial<JoinFactDeps> = {}) {
  const calls = { cp: 0, saved: [] as unknown[] };
  const d: JoinFactDeps = {
    managed: true,
    stored: null,
    people: 1,
    now: () => "2026-09-13T00:00:00.000Z",
    askCp: async () => { calls.cp++; return INVITE; },
    save: async (j) => { calls.saved.push(j); },
    registryVia: async () => null,
    onboardedElsewhere: async () => false,
    ...over,
  };
  return { d, calls };
}

test("M1 매니지드 — CP 값으로 정하고, 첫 성공 값을 한 번 저장한다", async () => {
  const { d, calls } = fake();
  const j = await resolveJoinFact(d);
  assert.equal(j.is_join, true);
  assert.equal(j.via, "invite");
  assert.equal(j.existing_account, true);
  assert.equal(calls.cp, 1);
  assert.deepEqual(calls.saved, [{ via: "invite", existing_account: true, at: "2026-09-13T00:00:00.000Z" }]);
});

test("M2 매니지드 — 저장된 값이 있으면 CP 를 다시 부르지 않고 그 값을 쓴다(폴링 자리)", async () => {
  const first = fake();
  await resolveJoinFact(first.d);
  const stored = first.calls.saved[0] as JoinFactDeps["stored"];
  const { d, calls } = fake({ stored, people: 9 });
  const j = await resolveJoinFact(d);
  assert.equal(calls.cp, 0, "저장값이 있는데 또 CP 를 부른다 — 처음 설정 폴링마다 계정 서버를 때린다");
  assert.equal(calls.saved.length, 0, "재사용하면서 또 저장한다");
  assert.deepEqual({ is_join: j.is_join, via: j.via, existing_account: j.existing_account }, { is_join: true, via: "invite", existing_account: true });
});

test("M3 매니지드 — CP 가 실패하면(502·시간 초과) 저장하지 않고 인원수로 폴백한다", async () => {
  for (const people of [1, 2]) {
    const { d, calls } = fake({ people, askCp: async () => { calls.cp++; throw Object.assign(new Error("계정 서버에 연결하지 못했습니다"), { status: 502 }); } });
    const j = await resolveJoinFact(d);
    assert.equal(calls.saved.length, 0, "실패를 저장했다 — 다음부터 영영 CP 에 다시 묻지 않는다");
    assert.equal(j.is_join, people >= 2, `사람 ${people}명 폴백이 지금 동작(인원수 ≥ 2)과 다르다`);
    assert.equal(j.via, null);
    assert.equal(j.existing_account, null, "모르는 것을 false 로 뭉갰다");
  }
});

test("M4 매니지드 — CP 대상이 없으면(null) 저장하지 않고 폴백한다", async () => {
  const { d, calls } = fake({ askCp: async () => null, people: 1 });
  const j = await resolveJoinFact(d);
  assert.equal(calls.saved.length, 0);
  assert.deepEqual({ is_join: j.is_join, via: j.via, existing_account: j.existing_account }, { is_join: false, via: null, existing_account: null });
});

test("M5 매니지드 — 응답 모양이 계약과 다르면 저장하지 않는다(지어내지 않는다)", async () => {
  const bad: unknown[] = [
    { ok: false, joined_via: "invite", account_existed: true },
    { ok: true, joined_via: "guest", account_existed: true },
    { ok: true, account_existed: true },
    { ok: true, joined_via: "invite", account_existed: "yes" },
    "invite", 42, [],
  ];
  for (const raw of bad) {
    const { d, calls } = fake({ askCp: async () => raw, people: 2 });
    const j = await resolveJoinFact(d);
    assert.equal(calls.saved.length, 0, `계약과 다른 응답을 저장했다: ${JSON.stringify(raw)}`);
    assert.equal(j.via, null, `계약과 다른 응답에서 via 를 지어냈다: ${JSON.stringify(raw)}`);
    assert.equal(j.is_join, true, "폴백이 인원수를 안 본다");
  }
});

test("M6 매니지드 — 만든 사람은 사람이 여럿이어도 합류자가 아니다(인원수가 판정하지 않는다)", async () => {
  const { d } = fake({ people: 5, askCp: async () => ({ ok: true, is_creator: true, joined_via: "creator", account_existed: false }) });
  const j = await resolveJoinFact(d);
  assert.equal(j.is_join, false);
  assert.equal(j.via, "creator");
  assert.equal(j.existing_account, false);
});

test("S1 셀프호스트 — 등록부가 판정하고 CP 는 부르지 않는다 · existing_account 는 다른 워크스페이스 완료 여부", async () => {
  for (const [via, elsewhere] of [["invite", true], ["creator", false]] as const) {
    const { d, calls } = fake({ managed: false, people: 1, registryVia: async () => via, onboardedElsewhere: async () => elsewhere });
    const j = await resolveJoinFact(d);
    assert.equal(calls.cp, 0, "셀프호스트가 계정 서버에 묻는다");
    assert.equal(calls.saved.length, 0);
    assert.deepEqual({ is_join: j.is_join, via: j.via, existing_account: j.existing_account }, { is_join: via === "invite", via, existing_account: elsewhere });
  }
});

test("S2 셀프호스트 primary — 등록부 판정이 없으면 인원수로 폴백하되 existing_account 는 계산한다", async () => {
  const { d } = fake({ managed: false, people: 3, registryVia: async () => null, onboardedElsewhere: async () => true });
  const j = await resolveJoinFact(d);
  assert.deepEqual({ is_join: j.is_join, via: j.via, existing_account: j.existing_account }, { is_join: true, via: null, existing_account: true });
});

// ── 배선 — 판정이 실제로 그 자리에 쓰이나 ─────────────────────────────────────
const SRC = read("./welcome.ts");
const CODE = strip(SRC);

test("M7 CP 계약 — /api/tenant/membership 을 짧은 제한 시간으로 부르고, 첫 성공 값은 워크스페이스 층 join 에 산다", () => {
  assert.match(CODE, /callCp\(t, "\/api\/tenant\/membership", \{\}, \{ timeoutMs: 5_000 \}\)/, "계정 서버 계약 경로·제한 시간이 다르다");
  const MEMBERS = strip(read("../../org/store/members.ts"));
  assert.match(MEMBERS, /export const WORKSPACE_SCOPED_KEYS = \[[^\]]*"join"[^\]]*\] as const;/, "join 이 워크스페이스 층이 아니다 — 두 번째 워크스페이스가 첫 번째 합류 사실을 덮는다");
  //  welcome 은 완료 반영이 통째로 덮는다 — 거기 넣으면 반영 순간 합류 사실이 사라진다.
  assert.doesNotMatch(MEMBERS, /interface LivWelcome \{[^}]*\bvia\b/, "합류 사실을 welcome 안에 넣었다");
  //  화면에 내주는 사실 — 판정값을 그대로 싣는다.
  assert.match(CODE, /joining: \{ is_join: join\.is_join, via: join\.via, existing_account: join\.existing_account,/, "처음 설정 현황이 판정값(via·existing_account)을 안 싣는다");
  assert.match(CODE, /workspace_purpose: /, "먼저 정한 사람의 용도를 안 싣는다");
});

test("A1 ★반영 — 합류자면 갈래·증류기·레인·묶음·리브 킥오프를 부르지 않는다 · 판정은 서버가 스스로 한다", () => {
  const start = CODE.indexOf('restRead("me_welcome_apply"');
  assert.ok(start >= 0, "반영 문을 못 찾았다 — 검사가 헛돈다");
  const HANDLER = CODE.slice(start, CODE.indexOf("\n];", start));
  //  화면이 보낸 값을 믿지 않는다 — 합류 여부를 입력에서 읽는 자리가 없어야 한다.
  assert.doesNotMatch(HANDLER, /input\.(joining|is_join|via|existing_account)\b/, "합류 여부를 화면이 보낸 값에서 읽는다");
  assert.match(HANDLER, /const joining = await currentJoinFact\(userId\);/, "반영이 합류 사실을 스스로 판정하지 않는다");
  const gate = blockFrom(HANDLER, "if (!joining.is_join) {");
  assert.ok(HANDLER.indexOf("const joining = await currentJoinFact") < HANDLER.indexOf("if (!joining.is_join) {"), "판정보다 문이 먼저 온다");
  for (const call of ["createCategory(", "ensureLocalFilesDistiller(", "applyLaneSkeleton(", "seedCategoryGroups("]) {
    assert.ok(gate.includes(call), `${call} 가 합류자 문 안에 없다`);
    assert.equal(HANDLER.split(call).length, gate.split(call).length, `${call} 가 합류자 문 밖에서도 불린다 — 합류자가 팀 구조를 바꾼다`);
  }
  //  사람의 것(이름·하는 일·완료 표식·진행 지우기)은 문 밖에서 그대로 한다.
  for (const keep of ["upsertMember(", "setLivWelcomeProgress(userId, null)", "onboarded: true", "work: { asis:"]) {
    assert.ok(HANDLER.includes(keep), `${keep} 가 반영에서 사라졌다`);
    assert.ok(!gate.includes(keep), `${keep} 가 합류자 문 안에 들어가 합류자에게는 안 남는다`);
  }
  assert.match(HANDLER, /const liv = joining\.is_join\s*\?\s*\{ session_id: null, href: null, reason: "join" \}\s*:\s*await kickoffLivAfterWelcome\(/,
    "합류자에게도 리브를 띄운다(또는 건너뛴 이유를 안 싣는다)");
  assert.equal(HANDLER.split("kickoffLivAfterWelcome(").length, 2, "킥오프를 부르는 자리가 하나가 아니다");
  assert.match(HANDLER, /joining: \{ is_join: joining\.is_join, via: joining\.via \}/, "화면이 마무리 문구를 가를 판정을 응답에 안 싣는다");
});

test("A3 ★반영 — 합류자의 용도(stage)는 워크스페이스 용도가 되지 않는다 · 합류자 칸엔 지금의 용도를 적는다 (원준 2026-09-14 · 격리 리뷰)", () => {
  const start = CODE.indexOf('restRead("me_welcome_apply"');
  assert.ok(start >= 0, "반영 문을 못 찾았다 — 검사가 헛돈다");
  const HANDLER = CODE.slice(start, CODE.indexOf("\n];", start));
  //  workspacePurposeStage 는 구성원의 welcome.stage 를 «먼저 답한 순» 으로 읽는다 — 합류자의 답이 그 칸에 들어가면 워크스페이스 용도가 된다.
  assert.match(HANDLER, /const stage = joining\.is_join\s*\?\s*await workspacePurposeStage\(currentTenant\(\)\?\.id \?\? null\)\.catch\(\(\) => null\)\s*:\s*s\(input\.stage, 40\);/,
    "합류자가 보낸 용도가 그대로 welcome.stage 에 적힌다 — 먼저 끝낸 합류자가 워크스페이스 용도를 정한다");
  assert.match(HANDLER, /welcome: \{[^}]*stage: stage \|\| null \}/, "완료 표식의 stage 가 판정한 값을 안 쓴다");
  const gate = blockFrom(HANDLER, "if (!joining.is_join) {");
  assert.ok(gate.includes("s(input.stage, 40)"), "묶음 시드가 주인 문 안에서 화면 값을 안 읽는다(무회귀)");
  assert.equal(HANDLER.split("s(input.stage, 40)").length - 1, 2, "화면이 보낸 용도를 읽는 자리가 주인 문(묶음 시드)과 주인 갈래 둘이 아니다");
});

test("A2 리브 1턴에 합류자 갈래가 남아 있지 않다 — 이제 불리지 않는 분기다", () => {
  const FIRST = strip(read("../../org/liv/first-turn.ts"));
  assert.doesNotMatch(FIRST, /joining|is_join/, "합류자 갈래가 죽은 분기로 남았다");
  assert.doesNotMatch(strip(SRC.slice(SRC.indexOf("export async function kickoffLivAfterWelcome"))), /joining:/, "킥오프가 아직 합류 사실을 1턴에 싣는다");
});

test("U1 업로드 — 개인 루트 업로드를 «올린 사람만» 으로 잠그지 않는다 (#4007)", () => {
  //  왜 '없음' 을 단언하나: 이건 되돌리기 쉬운 삭제다. 자료·지식은 이미 워크스페이스로 갈리므로(RLS tenant_isolation,
  //   #1875 실측 자료 100 vs 0) 그 안쪽 자동 잠금은 중복 기제였고, 실제로 부작용만 냈다(정책 0개 조직에 잠긴 자료 69건 ·
  //   공개 포스터 지식이 derived_from 상속으로 잠김 · db_query self 전면 차단). 워크스페이스 안에서 가르고 싶으면
  //   그건 부서 구분이고 도구는 org_source_vis_policy(EE)다 — 로컬 업로드도 stampSourceVisibility 를 지나므로 그게 먹는다.
  const INGEST = strip(read("../../ingest/local-file.ts"));
  assert.doesNotMatch(INGEST, /applyVisibility/, "개인 루트 자동 잠금이 되살아났다 — axisOn 가드를 우회하는 자리다");
  assert.doesNotMatch(INGEST, /shareWithTeam/, "풀 잠금이 없는데 푸는 옵션이 남았다");
  //  옵션은 라우트 → ingestLocalUpload 두 자리를 건넜다. 지운 것도 두 자리 다 봐야 한다.
  //   (main 은 #3787 D 로 마무리가 ingest/upload-finish.ts 로 빠져 세 자리다 — stage 엔 그 파일이 없다.)
  const ROUTE = strip(read("../../terminal/terminal-files.ts"));
  assert.doesNotMatch(ROUTE, /shareWithTeam/, "라우트에 죽은 배선이 남았다");
});
