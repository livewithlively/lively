// 프로젝트 초대제(#5598) — 화면이 «누가 보나» 를 말하는 규칙(web/lib/proj-access.ts)과 그 배선.
//
//  ⚠ web 은 dist 로 굽히지 않는다 — 순수 모듈의 소스를 읽어 TypeScript 로 옮긴 뒤 불러온다(projects-sidebar-cards.test.ts 와 같은 방식).
//
//  사양 · 엣지 표(spec-failfirst)
//   B1  초대제 · 나 혼자 → 자물쇠 «나만»
//   B2  초대제 · 내가 만들고 팀원 있음 → «N명과 공유»(나는 세지 않는다) · 설명에 이름
//   B3  초대제 · 남이 만들고 내가 팀원 → «초대받음» · 설명에 만든 사람
//   B4  열린 프로젝트 → «전체 공개»(자물쇠 아님)
//   B5  ★전체 공개 방식의 초안(풀리면 열린다) → «초안 동안 나만» · 설명이 «작업을 남기면 전체 공개» 를 말한다
//   B6  ★초대제인 초안 → «나만»(풀려도 안 열린다 — «공개돼요» 라고 말하지 않는다)
//   B7  팀원이 id 글자 배열이어도 · {member_id} 여도 같은 답 · 만든 사람이 팀원에 겹쳐 있어도 한 번만 센다
//   B8  새 값 비었음 — null · 빈 행 · 만든 사람 없음 · 이름 찾기 없음에도 던지지 않는다
//   B9  경계 — 설명의 이름은 3명까지 다 적고 4명부터 «외 N명»
//   B10 ★잠긴 리스트 안의 (초대제 · 초안이 아닌) 프로젝트 → «리스트 대상만»(자물쇠) — «전체 공개» 라고 말하지 않는다 ·
//       초대제이면서 잠긴 리스트 안이면 초대제 표시가 이긴다(더 좁은 쪽)
//   S1  ★축이 꺼진 워크스페이스 — 아무 표시도 안 한다(가려지는 게 없는데 자물쇠를 그리면 거짓 안심)
//   S2  닫힌 프로젝트 — 방식과 상관없이 표시한다
//   S3  열린 프로젝트 — 초대제 워크스페이스에서만 표시한다(전체 공개 워크스페이스에서는 소음)
//   N1  ★세션 초대 안내 — 닫힌 프로젝트면 프로젝트 이름과 함께 «프로젝트도 함께 보게 돼요»
//   N2  열린 프로젝트 · 프로젝트 없음 · 축 꺼짐 → 안내 없음(null)
//   N3  초대 뒤 토스트 꼬리 — 닫힌 프로젝트만
//   N4  이름 없는 안내(새 세션 · 컴포저) — 축이 꺼진 워크스페이스에서는 빈 글(말하지 않는다)
//   H1  새로 만드는 자리의 한 줄 — 방식 · 자동 생성 여부 · 축 꺼짐
//   D1  초안 뱃지 설명 — 초대제인 초안은 «공개됩니다» 라고 말하지 않는다
//   O1  관리탭 선택지 — 초대제 · 전체 공개 둘 · 초대제가 먼저
//   W1  배선 — 목록 줄 · 칸반 · 「리스트」 뷰 · 프로젝트 화면 속성 띠 · 세션 문패가 projAccessTag/projAccessChip 을 쓴다
//   W2  배선 — 세션 [공유] 창 · 새 세션 창 · 컴포저 @초대가 «프로젝트도 함께 보게 된다» 를 말한다
//   W3  배선 — 프로젝트 [공유] 창이 세션 [공유] 와 같은 Enter 규칙(lib/share-enter)을 쓰고 한글 조합 가드가 있다
//   W4  배선 — 관리탭이 새 프로젝트 공개 방식을 그리고 «이미 있는 프로젝트는 그대로» 를 말한다
//   W5  배선 — 자물쇠 그림이 아이콘 표에 있다 · 새 프로젝트 창이 공개 범위를 고르게 한다
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mod: any = null;
async function load() {
  if (mod) return mod;
  const js = ts.transpileModule(readFileSync("web/lib/proj-access.ts", "utf8"),
    { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  mod = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));
  return mod;
}
const ME = "me", OWNER = "owner", X = "x", Y = "y", Z = "z", W = "w";
const NAMES: Record<string, string> = { me: "상민", owner: "원준", x: "민지", y: "지호", z: "서연", w: "도윤" };
const nameOf = (id: string) => NAMES[id] || id;
const INVITE = { mode: "invite", enforced: true }, OPEN = { mode: "open", enforced: true }, OFF = { mode: "invite", enforced: false };

test("B1 초대제 · 나 혼자 → 자물쇠 «나만»", async () => {
  const m = await load();
  const b = m.projAccessBadge({ invite_only: true, created_by: ME, members: [] }, ME, nameOf);
  assert.deepEqual({ kind: b.kind, locked: b.locked, label: b.label, others: b.others }, { kind: "only_me", locked: true, label: "나만", others: 0 });
  assert.match(b.tip, /나만 보는 프로젝트/);
});

test("B2 초대제 · 내가 만들고 팀원 있음 → «N명과 공유» · 설명에 이름", async () => {
  const m = await load();
  const b = m.projAccessBadge({ invite_only: true, created_by: ME, members: [{ member_id: X }, { member_id: Y }] }, ME, nameOf);
  assert.equal(b.kind, "shared"); assert.equal(b.label, "2명과 공유"); assert.equal(b.others, 2); assert.equal(b.locked, true);
  assert.match(b.tip, /민지, 지호/);
});

test("B3 초대제 · 남이 만들고 내가 팀원 → «초대받음» · 설명에 만든 사람", async () => {
  const m = await load();
  const b = m.projAccessBadge({ invite_only: true, created_by: OWNER, members: [{ member_id: ME }, { member_id: X }] }, ME, nameOf);
  assert.equal(b.kind, "invited"); assert.equal(b.label, "초대받음"); assert.equal(b.locked, true);
  assert.match(b.tip, /원준님이 만든 프로젝트/); assert.match(b.tip, /나 포함 3명/);
});

test("B4 열린 프로젝트 → «전체 공개»(자물쇠 아님)", async () => {
  const m = await load();
  const b = m.projAccessBadge({ invite_only: false, draft: false, created_by: ME, members: [{ member_id: X }] }, ME, nameOf);
  assert.deepEqual({ kind: b.kind, locked: b.locked, label: b.label }, { kind: "open", locked: false, label: "전체 공개" });
});

test("B5 ★전체 공개 방식의 초안 → «초안 동안 나만» · 설명이 언제 열리는지 말한다", async () => {
  const m = await load();
  const p = { draft: true, invite_only: false, created_by: ME, members: [] };
  assert.equal(m.isPendingOpen(p), true);
  const b = m.projAccessBadge(p, ME, nameOf);
  assert.equal(b.label, "초안 동안 나만"); assert.equal(b.locked, true);
  assert.match(b.tip, /작업을 남기거나 제목 · 본문을 정리하면 전체 공개/);
  const shared = m.projAccessBadge({ ...p, members: [{ member_id: X }] }, ME, nameOf);
  assert.equal(shared.label, "1명과 공유"); assert.match(shared.tip, /전체 공개돼요/);
});

test("B6 ★초대제인 초안 → «나만»(풀려도 안 열린다)", async () => {
  const m = await load();
  const p = { draft: true, invite_only: true, created_by: ME, members: [] };
  assert.equal(m.isPendingOpen(p), false);
  const b = m.projAccessBadge(p, ME, nameOf);
  assert.equal(b.label, "나만"); assert.doesNotMatch(b.tip, /공개돼요/);
});

test("B7 팀원 꼴이 달라도 같은 답 · 만든 사람이 겹쳐도 한 번만", async () => {
  const m = await load();
  assert.deepEqual(m.projAudience({ created_by: ME, members: [X, ME, { member_id: X }, { id: Y }] }), [ME, X, Y]);
  assert.equal(m.projAccessBadge({ invite_only: true, created_by: ME, members: [ME, X] }, ME, nameOf).label, "1명과 공유");
});

test("B8 새 값 비었음 — 던지지 않는다", async () => {
  const m = await load();
  assert.equal(m.projAccessBadge(null, ME).kind, "open");
  assert.equal(m.projAccessBadge(undefined, "").kind, "open");
  assert.equal(m.projAccessBadge({}, ME).kind, "open");
  assert.equal(m.isPrivateProj(null), false);
  assert.deepEqual(m.projAudience(null), []);
  //  만든 사람이 비어 있는 닫힌 행(옛 초안) — 닫힌 것으로 읽되 던지지 않는다.
  assert.equal(m.projAccessBadge({ draft: true, created_by: null, members: null }, ME).locked, true);
  //  이름 찾기를 안 줘도 id 로 적는다.
  assert.match(m.projAccessBadge({ invite_only: true, created_by: ME, members: [X] }, ME).tip, /\(x\)/);
});

test("B9 경계 — 이름은 3명까지 다 적고 4명부터 «외 N명»", async () => {
  const m = await load();
  const three = m.projAccessBadge({ invite_only: true, created_by: ME, members: [X, Y, Z] }, ME, nameOf);
  assert.match(three.tip, /민지, 지호, 서연\)/); assert.doesNotMatch(three.tip, /외 /);
  const four = m.projAccessBadge({ invite_only: true, created_by: ME, members: [X, Y, Z, W] }, ME, nameOf);
  assert.equal(four.label, "4명과 공유");
  assert.match(four.tip, /민지, 지호, 서연 외 1명\)/);
});

test("B10 ★잠긴 리스트 안의 프로젝트 → «리스트 대상만» — «전체 공개» 라고 말하지 않는다", async () => {
  const m = await load();
  const b = m.projAccessBadge({ invite_only: false, draft: false, created_by: ME, list_locked: true }, ME, nameOf);
  assert.deepEqual({ kind: b.kind, locked: b.locked, label: b.label }, { kind: "list", locked: true, label: "리스트 대상만" });
  assert.doesNotMatch(b.tip, /구성원 모두/);
  assert.equal(m.showAccessBadge(b, OPEN), true, "전체 공개 방식의 워크스페이스에서도 표시한다(닫힌 것이다)");
  assert.equal(m.showAccessBadge(b, OFF), false, "축이 꺼지면 리스트 잠금도 강제되지 않는다");
  //  초대제이면서 잠긴 리스트 안 — 더 좁은 쪽(초대제)을 말한다.
  assert.equal(m.projAccessBadge({ invite_only: true, created_by: ME, list_locked: true }, ME, nameOf).label, "나만");
  //  list_locked 가 false · 없음이면 종전대로 전체 공개.
  assert.equal(m.projAccessBadge({ invite_only: false, list_locked: false }, ME).kind, "open");
});

test("S1~S3 표시할까 — 축 꺼짐 · 닫힘 · 열림", async () => {
  const m = await load();
  const locked = m.projAccessBadge({ invite_only: true, created_by: ME }, ME);
  const open = m.projAccessBadge({ invite_only: false }, ME);
  assert.equal(m.showAccessBadge(locked, OFF), false, "S1 축이 꺼지면 닫힌 것도 표시하지 않는다");
  assert.equal(m.showAccessBadge(open, OFF), false, "S1 축이 꺼지면 열린 것도 표시하지 않는다");
  assert.equal(m.showAccessBadge(locked, INVITE), true, "S2 닫힌 것은 초대제에서 표시");
  assert.equal(m.showAccessBadge(locked, OPEN), true, "S2 닫힌 것은 전체 공개에서도 표시");
  assert.equal(m.showAccessBadge(open, INVITE), true, "S3 열린 것은 초대제에서 표시(예외라 눈에 띄어야)");
  assert.equal(m.showAccessBadge(open, OPEN), false, "S3 열린 것은 전체 공개에서 표시하지 않는다(보통이라 소음)");
});

test("N1~N3 세션 초대 안내 — 닫힌 프로젝트일 때만", async () => {
  const m = await load();
  const closed = { name: "  가격  정책 ", invite_only: true, created_by: ME };
  const note = m.sessionInviteProjectNote(closed, INVITE);
  assert.match(note, /프로젝트 «가격 정책»도 함께 보게 돼요/);
  assert.match(note, /다른 세션은 따로 초대/);
  assert.match(m.sessionInviteProjectNote({ draft: true }, OPEN), /프로젝트도 함께 보게 돼요/, "이름이 없으면 이름 없이 · 초안도 닫힌 프로젝트다");
  assert.equal(m.sessionInviteProjectNote({ name: "열린 것", invite_only: false, draft: false }, INVITE), null, "N2 열린 프로젝트");
  assert.equal(m.sessionInviteProjectNote(null, INVITE), null, "N2 프로젝트 없음");
  assert.equal(m.sessionInviteProjectNote(closed, OFF), null, "N2 축 꺼짐");
  assert.match(m.sessionInviteProjectNote(closed), /가격 정책/, "설정을 안 주면 기본값(초대제 · 켜짐)");
  assert.equal(m.sessionInviteProjectToast(closed, INVITE), " 프로젝트 «가격 정책»도 함께 볼 수 있어요.");
  assert.equal(m.sessionInviteProjectToast({ invite_only: false }, INVITE), "");
  assert.equal(m.sessionInviteProjectToast(closed, OFF), "");
  assert.equal(m.sessionInviteProjectToast(null), "");
  assert.match(m.SESSION_INVITE_PROJECT_NOTE_GENERIC, /프로젝트도 함께 보게 돼요/);
  //  N4 — 이름 없는 안내는 축이 켜져 있을 때만.
  assert.equal(m.sessionInviteGenericNote(INVITE), m.SESSION_INVITE_PROJECT_NOTE_GENERIC);
  assert.equal(m.sessionInviteGenericNote(OPEN), m.SESSION_INVITE_PROJECT_NOTE_GENERIC, "전체 공개 방식에서도 초안 프로젝트는 닫혀 있다");
  assert.equal(m.sessionInviteGenericNote(OFF), "");
  assert.equal(m.sessionInviteGenericNote(), m.SESSION_INVITE_PROJECT_NOTE_GENERIC, "설정을 안 주면 기본값(켜짐)");
});

test("H1 새로 만드는 자리의 한 줄", async () => {
  const m = await load();
  assert.match(m.newProjectAccessHint(INVITE), /새 프로젝트는 나만 봐요/);
  assert.match(m.newProjectAccessHint(INVITE, true), /함께 생기는 프로젝트는 나만 봐요/);
  assert.match(m.newProjectAccessHint(OPEN), /구성원 모두가 봐요/);
  assert.match(m.newProjectAccessHint(OPEN, true), /초안인 동안 나만 보고, 작업을 남기면/);
  assert.equal(m.newProjectAccessHint(OFF), "");
});

test("D1 초안 뱃지 설명 — 초대제인 초안은 «공개됩니다» 라고 말하지 않는다", async () => {
  const m = await load();
  assert.doesNotMatch(m.draftTipFor({ draft: true, invite_only: true }), /공개됩니다/);
  assert.match(m.draftTipFor({ draft: true, invite_only: true }), /초대한 사람만/);
  assert.match(m.draftTipFor({ draft: true, invite_only: false }), /모두에게 공개됩니다/);
  assert.match(m.draftTipFor(null), /모두에게 공개됩니다/);
});

test("O1 관리탭 선택지 — 초대제가 먼저, 둘", async () => {
  const m = await load();
  assert.deepEqual(m.ACCESS_MODE_OPTIONS.map((o: { mode: string }) => o.mode), ["invite", "open"]);
  assert.match(m.ACCESS_MODE_OPTIONS[1].desc, /초안만 만든 사람이 보다가, 작업을 남기면 자동으로 공개/);
  assert.deepEqual(m.ACCESS_CONFIG_DEFAULT, { mode: "invite", enforced: true });
});

const read = (p: string) => readFileSync(p, "utf8");

test("W1 배선 — 목록 줄 · 칸반 · 「리스트」 뷰 · 속성 띠 · 문패가 한 부품을 쓴다", () => {
  assert.match(read("web/projects/rows.ts"), /const accessTag = projAccessTag\(p, \{ compact: true \}\);[\s\S]{0,200}caret, lead, title, accessTag, draftTag,/);
  assert.match(read("web/projects/board.ts"), /const kbAcc = projAccessTag\(p, \{ compact: true \}\);/);
  assert.match(read("web/projects/board.ts"), /setAccessConfig\(d && d\.access\)/, "보드가 목록 응답의 access 를 받아 둔다");
  assert.match(read("web/projects/session-list.ts"), /const acc = projAccessTag\(it\.proj, \{ compact: true \}\);/);
  assert.match(read("web/projects/detail-meta.ts"), /let accChip = projAccessChip\(p, members \|\| \[\], reloadKeep\);/);
  assert.match(read("web/projects/detail-meta.ts"), /pjvProjStatusPill\(p, reload\)\),[\s\S]{0,260}accChip,\s*draftChip,/, "칩은 상태 다음 · 초안 앞");
  assert.match(read("web/projects/detail.ts"), /setAccessConfig\(d && d\.access\)/, "주소로 바로 연 프로젝트 화면도 설정을 받는다");
  assert.match(read("web/v2/panes.ts"), /loose \? null : doorAccess\(p\)\)\),/);
  assert.match(read("web/v2/panes.ts"), /openProjectSharePopover\(btn, detail\.project,/);
  //  서버가 그 재료를 실어 준다 — 목록 · 상세 응답 둘 다.
  const cap = read("src/capabilities/projects-v6.ts");
  //   projectAccessInfo = 방식 + 강제되는가(축 켜짐 ∧ 초대제 칸이 이 DB 에 있다 — 롤 창에서는 false 라 화면이 «나만» 이라고 말하지 않는다).
  assert.equal((cap.match(/access: await projectAccessInfo\(\)/g) || []).length, 2);
  assert.match(read("src/v6/project-access.ts"), /return \{ mode, enforced: axis && col \};/);
  //  잠긴 리스트 표시도 목록 · 상세 둘 다에 단다.
  assert.equal((cap.match(/await markListLocked\(/g) || []).length, 2);
});

test("W2 배선 — 세션 초대 자리 셋이 «프로젝트도 함께 보게 된다» 를 말한다", () => {
  const share = read("web/v2/share-session.ts");
  assert.match(share, /sessionInviteProjectNote\(proj, projCfg\)/);
  assert.match(share, /fine\('고른 사람만 이 세션을 보고 열 수 있어요\.'\),\s*projNote\(\),/, "안내는 저장 단추 위에 선다");
  assert.match(share, /sessionInviteProjectToast\(proj, projCfg\)/);
  assert.match(share, /s\.owned && s\.projectId/, "초대를 고칠 수 있는 사람(주인)의 창에서만 프로젝트를 묻는다");
  assert.match(share, /projectId: Number\(s\.projectId \?\? raw\.projectId\) > 0/);
  const form = read("web/terminal/session-form.ts");
  assert.match(form, /sessionInviteProjectNote\(pj,/);
  assert.match(form, /field\('초대 \(비우면 나만 보는 비공개 세션\)', inviteBox\.box\), inviteProjNote\)/);
  assert.match(read("web/v2/compose-mention.ts"), /class: 'pn-att-note', text: '프로젝트도 함께 보게 돼요'/);
  //  이름 없는 안내 셋(새 세션 · 세션 수정 · 컴포저)은 축이 켜진 워크스페이스에서만 선다.
  assert.equal((form.match(/sessionInviteGenericNote\(acfg\)/g) || []).length, 2);
  assert.match(read("web/v2/compose-mention.ts"), /chosen\.length && sessionInviteGenericNote\(accessConfig\(\)\) \?/);
});

test("W3 배선 — 프로젝트 [공유] 창은 세션 [공유] 와 같은 손놀림이다", () => {
  const ui = read("web/projects/access-ui.ts");
  assert.match(ui, /import \{ inviteAdded, inviteDirty, shareEnterAction \} from '\.\.\/lib\/share-enter\.js';/);
  assert.match(ui, /if \(e\.key !== 'Enter' \|\| e\.isComposing\) return;/, "한글 조합 중의 Enter 는 확정이다");
  assert.match(ui, /class: 'pn-share pj-share'/, "세션 공유 창과 같은 틀");
  assert.match(ui, /\/api\/ui\/v6\/projects\/' \+ p\.id \+ '\/access'/);
  assert.match(ui, /\/api\/ui\/v6\/projects\/' \+ p\.id \+ '\/members'/);
  assert.match(ui, /const canRemove = \(id: string\): boolean => isOwner \|\| !invited\.includes\(id\);/, "남을 빼는 × 는 만든 사람에게만");
  assert.match(ui, /if \(!isOwner\) \{\s*return fine\(/, "공개 범위 바꾸기는 만든 사람에게만");
});

test("W4 배선 — 관리탭이 새 프로젝트 공개 방식을 그린다", () => {
  const ax = read("web/visibility-axes.ts");
  assert.match(ax, /api\('\/api\/ui\/v6\/project-access'\)/);
  assert.match(ax, /ACCESS_MODE_OPTIONS\.map\(opt\)/);
  assert.match(ax, /이미 있는 프로젝트의 공개 범위는 바뀌지 않습니다/);
  assert.match(ax, /access\.enforced \? null :/, "축이 꺼져 있으면 그 사실을 말한다");
});

test("W6 배선 — 관리탭의 «기존 프로젝트도 초대제로 바꾸기»: 미리보기 → 확인 → 실행", () => {
  const ax = read("web/visibility-axes.ts");
  assert.match(ax, /api\('\/api\/ui\/v6\/project-access\/existing'\)/, "몇 건이 닫히는지 먼저 받는다");
  assert.match(ax, /access\.enforced \? existingRow\(existing, reload\) : null/, "축이 꺼진 워크스페이스에는 단추를 세우지 않는다(닫아도 가려지지 않는다)");
  assert.match(ax, /if \(ex\.open <= 0\) \{/, "닫을 것이 없으면 단추 대신 그 사실을 말한다");
  assert.match(ax, /btn\.onclick = \(\) => confirmCloseExisting\(ex, reload\);/, "단추는 곧바로 실행하지 않고 확인 창을 연다");
  assert.match(ax, /method: 'POST', body: JSON\.stringify\(\{ confirm: true \}\)/, "실행은 확인 창의 단추에서만 · confirm 을 싣는다");
  assert.match(ax, /되돌리는 단추는 없습니다/);
  //  서버도 같은 순서를 강제한다 — 관리자만 · confirm 없으면 400.
  const cap = read("src/capabilities/vis-axes.ts");
  assert.match(cap, /name: "project_access_existing_close",[\s\S]{0,900}scope: "admin"/);
  assert.match(cap, /if \(!input\.confirm\) \{[\s\S]{0,200}throw new HttpError\(400,/);
});

test("W5 배선 — 자물쇠 그림 · 새 프로젝트 창의 공개 범위", () => {
  assert.match(read("web/lib/icon-paths.ts"), /\n  lock: '/);
  const form = read("web/projects/project-form.ts");
  assert.match(form, /accessSel\.value = cfg\.mode; accessRow\.hidden = false;/, "처음 값은 워크스페이스 설정");
  assert.match(form, /if \(!cfg\.enforced\) return;/, "축이 꺼진 워크스페이스에서는 줄을 세우지 않는다");
  assert.match(form, /accessRow\.hidden \? \{\} : \{ access: accessSel\.value \}/, "줄이 안 섰으면 값을 안 보낸다(서버 기본값)");
});
