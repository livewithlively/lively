// #4694 T4 — 복원을 **같은 세션 id** 로. 사양 기반 엣지 표 + 배선 가드.
//
//  사양(태스크 #4694 · 상민님 결정 2026-10-14 «T3 뒤에 켠다» → 2026-10-15 T3 전 테넌트·실측 뒤 «다른 워크스페이스도 켠다»):
//   · 옛 판이 없다는 확답이 있을 때만 같은 id 로 다시 띄운다. 살아 있으면 복원할 것이 없고(already), «모름» 에서 사람이 고른
//     강제 복원은 종전대로 새 id(옛 id 를 은퇴시켜 브로커가 걷게) — 같은 id 로 강제하면 한 대화에 하네스 둘이 붙을 수 있다.
//   · 셀프호스트(세션 컨테이너 없음)는 늘. 매니지드는 워크스페이스 스위치(session_reclaim_policy.restore_same_id, 기본 켬 —
//     저장값 false 는 그 워크스페이스만, env 시드 0|off 는 게이트웨이 전체를 끈다).
//   · 같은 id 로 다시 띄운 세션은 프로세스가 기억하던 옛 판의 작업 시각으로 판정되지 않는다.
//   · 같은 id 갈래는 옮길 것이 없다 — 승계·옛 id 정리를 하지 않고, 실패해도 이 호출 전부터 있던 행을 지우지 않는다.
//  DB 쪽 사양(표식 정리 R1~R7 · 인스턴스 I1~I5)은 실 PG 로 잰다 — src/sessions/session-revive.pg-test.mjs.
//
//  엣지 표
//   V1 확답 없음 + 셀프호스트 + 스위치 끔             → 같은 id
//   V2 확답 없음 + 매니지드 + 스위치 끔               → 새 id(종전)
//   V3 확답 없음 + 매니지드 + 스위치 켬               → 같은 id
//   V4 살아 있음(false) — 어떤 토폴로지·스위치든      → 같은 id 아님(already 로 끝난다)
//   V5 모름(null, 강제 복원) — 어떤 토폴로지·스위치든 → 같은 id 아님
//   L1~L6 마지막 작업 시각(lastBusyFor) — 옛 기억 버림 · 지금 판 유지 · 태어난 시각 모름 · 영속값 · 경계 · 기억 없음
//   P1~P4 스위치 기본 켬 · 워크스페이스 저장값이 끔 · env 시드가 전체를 끔(저장값이 이김) · 빈 env 시드는 없는 것
//   W1~W5 배선 — 같은 id 갈래가 승계·정리를 안 하고, 롤백이 행을 안 지우고, 화면이 같은 id 를 성공으로 읽는다
import { strict as assert } from "node:assert";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sameIdRestoreVerdict } from "./restore-same-id.js";
import { lastBusyFor } from "./tmux-exec.js";
import { normalizeSessionReclaimPolicy } from "../sessions/session-reclaim-policy.js";

test("[V1~V5] 같은 id 판정 — 옛 판이 없다는 확답 + (셀프호스트 또는 매니지드 스위치)", () => {
  const v = (gone: boolean | null, containerTopology: boolean, policyOn: boolean) => sameIdRestoreVerdict({ gone, containerTopology, policyOn });
  assert.equal(v(true, false, false), true, "V1 셀프호스트는 스위치와 무관하게 같은 id");
  assert.equal(v(true, true, false), false, "V2 매니지드 + 스위치 끔 → 종전(새 id)");
  assert.equal(v(true, true, true), true, "V3 매니지드 + 스위치 켬 → 같은 id");
  for (const [c, p] of [[false, false], [false, true], [true, false], [true, true]] as const) {
    assert.equal(v(false, c, p), false, `V4 살아 있음(container=${c} policy=${p}) — 같은 id 로 다시 만들지 않는다`);
    assert.equal(v(null, c, p), false, `V5 모름·강제(container=${c} policy=${p}) — 옛 판이 살아 있을 수 있다`);
  }
});

test("[L1~L6] 마지막 작업 시각 — 프로세스 기억이 지금 tmux 세션이 태어나기 전 값이면 버린다", () => {
  assert.equal(lastBusyFor(100, 0, 200), 0, "L1 옛 판의 기억은 버린다(같은 id 로 다시 띄운 세션)");
  assert.equal(lastBusyFor(300, 0, 200), 300, "L2 지금 판에서 관측한 기억은 그대로");
  assert.equal(lastBusyFor(100, 0, 0), 100, "L3 태어난 시각을 모르면 종전대로");
  assert.equal(lastBusyFor(100, 250, 200), 250, "L4 영속값(@box_last_busy)은 지금 tmux 세션과 함께 났으므로 그대로");
  assert.equal(lastBusyFor(200, 0, 200), 200, "L5 같은 초는 지금 판이다(경계)");
  assert.equal(lastBusyFor(0, 0, 200), 0, "L6 기억도 영속값도 없으면 0(회수기는 생성 시각으로 폴백한다)");
});

test("[P1~P4] 매니지드 스위치 — 기본 켬 · 워크스페이스 저장값 · env 시드(끄는 수단)", () => {
  const saved = process.env.LIVELY_SESSION_RESTORE_SAME_ID;
  try {
    delete process.env.LIVELY_SESSION_RESTORE_SAME_ID;
    assert.equal(normalizeSessionReclaimPolicy(null).restore_same_id, true, "P1 값이 없으면 켬(T3 자리 이름 전 테넌트 롤아웃 뒤)");
    assert.equal(normalizeSessionReclaimPolicy({ idle_ttl_minutes: 120 }).restore_same_id, true, "P1 옛 저장값(이 칸 이전)도 켬");
    assert.equal(normalizeSessionReclaimPolicy({ restore_same_id: false }).restore_same_id, false, "P2 워크스페이스 저장값이 그 워크스페이스만 끈다");
    process.env.LIVELY_SESSION_RESTORE_SAME_ID = "0";
    assert.equal(normalizeSessionReclaimPolicy(null).restore_same_id, false, "P3 env 시드 0 이 게이트웨이 전체를 끈다");
    process.env.LIVELY_SESSION_RESTORE_SAME_ID = "off";
    assert.equal(normalizeSessionReclaimPolicy({ idle_ttl_minutes: 120 }).restore_same_id, false, "P3 env 시드 off 도 끈다(이 칸 없는 옛 저장값 위에서도)");
    assert.equal(normalizeSessionReclaimPolicy({ restore_same_id: true }).restore_same_id, true, "P3 워크스페이스 저장값이 env 시드를 이긴다");
    process.env.LIVELY_SESSION_RESTORE_SAME_ID = "";
    assert.equal(normalizeSessionReclaimPolicy(null).restore_same_id, true, "P4 빈 env 시드는 없는 것과 같다(켬)");
  } finally {
    if (saved === undefined) delete process.env.LIVELY_SESSION_RESTORE_SAME_ID; else process.env.LIVELY_SESSION_RESTORE_SAME_ID = saved;
  }
});

// ── 배선 — 판정이 맞아도 그 결과를 쓰는 자리가 어긋나면 소용없다. 소스에서 그 자리를 잰다(이 레포의 배선 시험 관례). ──
//  라우트·createSession 은 tmux·중계·DB 를 통째로 물어 행위로 재려면 실 박스가 필요하다 — 그 행위는 배포 뒤 실측으로 잰다
//  (껐다 다시 연 세션이 같은 주소·같은 장부 행으로 이어지나). 여기서는 «부르면 안 되는 것을 부르지 않는다» 를 못박는다.
const SRC = join(process.cwd(), "src");
const WEB = join(process.cwd(), "web");
const read = (p: string): string => readFileSync(p, "utf8");
/** `start` 를 처음 찾은 곳부터, 그 줄의 들여쓰기로 닫는 `}` 까지(그 블록 본문). */
function blockAfter(src: string, start: string): string {
  const i = src.indexOf(start);
  assert.ok(i >= 0, `블록 시작을 못 찾았다: ${start}`);
  const lineStart = src.lastIndexOf("\n", i) + 1;
  const indent = src.slice(lineStart, i).match(/^\s*/)![0];
  const end = src.indexOf(`\n${indent}}`, i);
  assert.ok(end > i, `블록 끝을 못 찾았다: ${start}`);
  return src.slice(i, end);
}

test("[W1] 복원 라우트의 같은 id 갈래 — 옮길 것이 없다: 승계·옛 id 정리를 하지 않고, 실패해도 행을 남긴다", () => {
  const routes = read(join(SRC, "terminal", "routes.ts"));
  assert.match(routes, /const sameId = await sameIdRestoreOn\(goneVerdict\);/, "판정이 옛 판의 생사 확답(goneVerdict)으로 이뤄져야 한다");
  assert.match(routes, /\.\.\.\(sameId \? \{ reuseId: id \} : \{\}\)/, "같은 id 면 createSession 에 그 id 를 넘겨야 한다");
  //  주석은 호출이 아니다 — 왜 안 부르는지를 적은 주석까지 걸리지 않게 줄 주석을 떼고 잰다.
  const blk = blockAfter(routes, "if (sameId) {").split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
  for (const banned of ["closeSessionAppInstances(", "carryOutbox(", "markSessionSuperseded(", "carrySessionDismissals(", "carryConvMapping(", "registerSessionInstance("]) {
    assert.ok(!blk.includes(banned), `🔴 같은 id 갈래가 ${banned} 를 부른다 — 같은 id 에선 방금 되살린 이 세션을 망가뜨린다`);
  }
  assert.ok(blk.includes("killSession(owner, id, { preserveState: true })"), "🔴 소속 기록 실패의 되물림이 행을 지운다(preserveState 없음)");
  assert.ok(blk.includes("reviveSessionInstance("), "인스턴스는 지금 상태로 가르는 reviveSessionInstance 로 세운다(치움 보존)");
  assert.ok(blk.includes("kickOutbox(id)"), "미전달 지시를 지금 깨워야 한다(죽은 동안 쌓인 재시도 대기를 기다리지 않게)");
  assert.ok(blk.includes("return;"), "같은 id 갈래는 새 id 갈래의 승계로 떨어지지 않고 끝난다");
});

test("[W2] createSession — 같은 id 재생성의 실패 되돌림이 이 호출 전부터 있던 행을 지우지 않는다", () => {
  const s = read(join(SRC, "terminal", "sessions.ts"));
  const fn = s.slice(s.indexOf("export async function createSession("), s.indexOf("\ninterface OwnerMeta"));
  assert.ok(fn.length > 1000, "createSession 본문을 못 잘랐다");
  //  행 삭제는 dropOwnRow 한 자리에서만 — 그 자리는 reuseId 면 지우지 않는다.
  assert.equal(fn.split("deleteSessionState(id)").length - 1, 1, "🔴 createSession 안에 dropOwnRow 밖의 행 삭제가 생겼다");
  assert.match(fn, /const dropOwnRow = \(\): Promise<void> => \(mirrored && !reuseId \? deleteSessionState\(id\)/, "🔴 되돌림이 같은 id 재생성의 행을 지운다");
  assert.equal(fn.split("await dropOwnRow()").length - 1, 3, "되돌림 세 자리(컨테이너 확보 · 판 · 표식)가 전부 dropOwnRow 를 지나야 한다");
});

test("[W3] createSession — 같은 id 면 «끝났다» 표식을 지우고(두 경로) 컨테이너는 새 자리로 청하고, 받아 줄 수 없는 id 면 던진다", () => {
  const s = read(join(SRC, "terminal", "sessions.ts"));
  assert.equal(s.split("&& reuseId) await reviveSessionState(id, ownerId(user))").length - 1, 2, "새 경로(컨테이너 안 tmux)·옛 경로 둘 다 표식을 지워야 한다");
  assert.match(s, /\.\.\.\(reuseId \? \{ fresh: true \} : \{\}\)/, "같은 id 재생성은 확보 요청에 fresh:true 를 싣는다(T3 계약)");
  assert.match(s, /if \(input\.reuseId !== undefined && !reuseId\) throw new HttpError\(400/, "받아 줄 수 없는 id 면 조용히 새 id 를 만들지 않고 던진다");
  assert.match(s, /let lastBusy = lastBusyFor\(getLastBusy\(p\.name\), persisted, Number\(p\.created\) \|\| 0\);/, "목록이 옛 판의 작업 시각을 버리는 규칙(lastBusyFor)을 써야 한다");
});

test("[W4] 화면 — 같은 id 응답을 성공으로 읽고, 그 탭을 살아 있는 세션으로 다시 그린다", () => {
  const chat = read(join(WEB, "session-chat.ts"));
  assert.match(chat, /if \(r\?\.session && next === target\.id\) \{/, "🔴 #3689 [이어서 열기]가 같은 id 를 실패(«복원할 수 있는 상태가 아니에요»)로 읽는다");
  const main = read(join(WEB, "v2", "main.ts"));
  assert.match(main, /function seedCreated\(id: string\): boolean \{/, "복원 응답으로 «중단됨» 행을 바꿔 끼우는 자리가 있어야 한다");
  assert.match(main, /if \(cur && !cur\.raw\?\.restorable\) return false;/, "살아 있는 행은 덮지 않는다(목록 폴링이 진실)");
  //  (#4970) 리브 칸(리브 탭의 대화 칸)은 걷었다 — 리브 세션은 보통 세션 라우트로 열리므로 그 한 자리가 둘 다를 맡는다.
  assert.ok((main.match(/seedCreated\((?:id|sid)\);/g) || []).length >= 1, "세션 라우트가 복원 응답을 먼저 쓴다");
  assert.doesNotMatch(main, /liv-chat\.js|mountSession: async \(h, sid, o\) => \{/, "리브 탭의 따로 붙이는 대화 칸이 남아 있다(복원 응답 규칙이 두 벌로 갈린다)");
  assert.match(main, /onResumed: \(nid\) => \{ tab\.chat\?\.destroy\(\); tab\.chat = null; resumedInTab\(tab, nid\); \}/, "팝아웃 창도 되살린 세션으로 다시 그린다(주소가 같아 hashchange 가 없다)");
});

test("[W5] 매니지드 스위치 — 관리 창구가 그 값을 받는다(검증·스키마 둘 다)", () => {
  const rc = read(join(SRC, "capabilities", "delivery", "runtime-config.ts"));
  assert.match(rc, /if \(s\.restore_same_id !== undefined\) patchIn\.restore_same_id = Boolean\(s\.restore_same_id\);/, "🔴 검증 블록에 없으면 저장 버튼이 200 을 받고도 값이 사라진다");
  assert.match(rc, /restore_same_id: z\.boolean\(\)\.optional\(\)/, "🔴 스키마(zod)에 없으면 미선언 키로 지워진다");
});
