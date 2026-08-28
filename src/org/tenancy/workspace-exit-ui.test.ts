// #1875 D5″ 화면 — **✕ 는 사람+ 옆에, 확인은 그 자리에서**(2026-08-28 장원준 지시 + 안 A 선택)
//
// 지시 원문: 「구성원 추가 옆에 X 아이콘 하나 추가로 만들어서 해달라고 했자나」
// 고른 안: A — "✕ 누르면 그 행 아래가 열린다. 목록을 안 떠난다."
//
// ── 왜 소스를 읽어 못박나 ───────────────────────────────────────────────────
// web/ 은 dist 로 컴파일되지 않아 유닛으로 몰 수 없다(레포 선례: managed-workspace-surface.test.ts,
//  session-privacy-invite-only.test.ts E12~E17). 그래서 «빠지면 조용히 기능이 사라지는» 구조만 고정한다.
//
// ── 엣지 표(무엇이 빠지면 무엇이 조용히 깨지나) ─────────────────────────────
//   E1 ✕ 가 행에 있다                    → 없으면 지시 그대로 미구현
//   E2 primary 에는 ✕ 가 없다            → 그리면 «박스를 나가는» 누를 수 없는 문이 생긴다
//   E3 갈래가 **어드민 수**로 갈린다      → 인원만 보면 유일 어드민이 그냥 나가진다(주인 없는 팀)
//   E4 유일 어드민에게 **넘길 사람 고르기**가 뜬다 → 없으면 8/27 의 '막고 준비 중' 으로 되돌아간다
//   E5 넘길 사람 목록에서 **나를 뺀다**    → 나를 고르면 서버가 400 — 고를 수 없는 걸 그리는 것
//   E6 확인이 **그 행 아래**에 열린다(안 A) → 다른 판으로 보내면 어느 워크스페이스인지가 사라진다
//   E7 확인은 **하나만** 열린다            → 둘 열리면 어느 것에 답하는 중인지 사라진다
//   E8 ★떠나는 문이 **한 곳**이다          → 옛 문(설정 판·팝오버 줄)이 남으면 셋이 된다
//   E9 설정 부제가 판 안의 사실과 맞는다   → 안 맞으면 열었을 때 없는 것을 약속한 셈
//   E10 워크스페이스 0개 상태를 말한다     → 빈 목록이면 사람은 «고장났다»로 읽는다
//   E11 나간 뒤 목록을 다시 읽는다         → 안 읽으면 방금 나온 곳이 목록에 남아 있다
import { strict as assert } from "node:assert";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function repoRoot(): string {
  let d = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) { if (existsSync(path.join(d, "package.json"))) return d; d = path.dirname(d); }
  throw new Error("레포 뿌리를 찾지 못했다");
}
const ROOT = repoRoot();
const read = (rel: string): string => readFileSync(path.join(ROOT, rel), "utf8");
const RAIL = read("web/v2/rail.ts");
const CSS = read("public/styles/47-v2-rail.css");
/** 주석은 빼고 본다 — 왜 그렇게 했는지는 주석에 남아야 하고, 그 문장까지 금지하면 «이유를 지워야 통과하는» 테스트가 된다. */
const CODE = RAIL.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

test("★ E1/E2 ✕ 가 사람+ 옆에 있고, primary 에는 없다", () => {
  assert.match(CODE, /addPeopleBtn\(w\), exitBtn\(w\)/,
    "★ 행에 ✕ 가 없다 — 「구성원 추가 옆에 X」 지시가 화면에 없다");
  const at = RAIL.indexOf("function exitBtn(");
  assert.ok(at > 0, "exitBtn 이 없다");
  const body = RAIL.slice(at, RAIL.indexOf("\nfunction closeExitInline", at));
  assert.match(body, /if \(w\.is_primary \|\| w\.slug === 'primary'\) return null;/,
    "★ primary 에 ✕ 를 그린다 — 박스 그 자체라 나갈 수도 지울 수도 없다(누를 수 없는 문)");
  assert.match(CSS, /\.v2-wspop-x\s*\{/, "✕ 규격이 CSS 에 없다 — 사람+ 와 짝이 안 맞는다");
});

test("★★ E3/E4/E5 갈래는 어드민 수 — 유일 어드민에겐 넘길 사람을 고르게 한다", () => {
  const at = RAIL.indexOf("function openExitInline(");
  assert.ok(at > 0, "openExitInline 이 없다");
  const body = RAIL.slice(at, RAIL.indexOf("\nfunction exitForm", at));
  //  ⚠ "문자열이 있다" 로는 부족하다 — 갈래의 **조건 자체**를 한 덩어리로 본다.
  assert.match(body, /const soleAdmin = iAmAdmin && \(w\.owner_count \?\? 1\) < 2;/,
    "★ 유일 어드민 판정이 owner_count 에서 안 나온다 — 인원만 보면 유일 어드민이 그냥 나가진다");
  assert.match(body, /if \(alone\) paintDelete[\s\S]{0,120}else if \(soleAdmin\) paintTransfer[\s\S]{0,60}else paintLeave/,
    "★ 세 갈래가 이 순서로 갈리지 않는다(혼자 → 유일 어드민 → 그 밖)");

  const tAt = RAIL.indexOf("function paintTransfer(");
  assert.ok(tAt > 0, "paintTransfer 가 없다 — 8/27 의 '막고 준비 중' 으로 되돌아갔다");
  const t = RAIL.slice(tAt, RAIL.indexOf("\nasync function afterExit", tAt));
  assert.match(t, /await leaveWorkspace\(w\.slug, to\)/, "고른 사람을 서버로 안 넘긴다");
  //  ⚠ «나» 를 가리키는 키가 배포마다 다르다 — 셀프호스트는 core member_id, 매니지드는 CP 계정 이메일.
  //   member_id 비교만 하면 매니지드에서 내가 후보에 남는다(고르면 400). 서버가 실어 주는 is_me 를 먼저 본다.
  assert.match(t, /filter\(\(m\) => \(typeof m\.is_me === 'boolean' \? !m\.is_me : m\.member_id !== me\)\)/,
    "★ 넘길 사람 목록에서 나를 빼지 않는다(또는 매니지드에서 못 뺀다) — 고르면 서버가 400 을 낸다");
});

test("★ E6/E7 확인은 그 행 아래에서, 하나만 열린다(안 A)", () => {
  assert.match(CODE, /row\.after\(box\)/,
    "★ 확인이 그 행 아래에 안 붙는다 — 다른 판으로 보내면 어느 워크스페이스 얘기인지가 사라진다");
  assert.match(CODE, /function closeExitInline\(\)[\s\S]{0,200}querySelectorAll\('\.v2-wspop-exit'\)[\s\S]{0,60}remove/,
    "열린 확인을 걷는 길이 없다");
  const at = RAIL.indexOf("function openExitInline(");
  const body = RAIL.slice(at, RAIL.indexOf("\nfunction exitForm", at));
  assert.ok(body.indexOf("closeExitInline()") < body.indexOf("row.after(box)"),
    "★ 새로 열기 전에 기존 확인을 안 닫는다 — 둘이 열리면 어느 것에 답하는 중인지 사라진다");
  assert.match(body, /if \(already\) return;/, "같은 ✕ 를 다시 눌러도 안 닫힌다(토글이 아니다)");
  assert.match(CSS, /\.v2-wspop-exit\s*\{/, "확인 블록 규격이 CSS 에 없다");
});

test("★★ E8 떠나는 문은 한 곳이다 — 옛 문이 남아 있지 않다", () => {
  assert.doesNotMatch(CODE, /function exitRow\(/,
    "★ 설정 판의 옛 «보관/나가기» 줄이 남아 있다 — 같은 일을 하는 문이 둘이 된다");
  assert.doesNotMatch(CODE, /row\('archive', '워크스페이스 나가기'/,
    "★ 팝오버의 옛 「워크스페이스 나가기」 줄이 남아 있다 — 문이 셋이 된다");
});

test("E9 설정 부제가 판 안의 사실과 맞는다(보관·나가기를 더는 약속하지 않는다)", () => {
  //  ⚠ 주석 뺀 CODE 로 본다 — 왜 걷었는지는 주석에 '보관/나가기' 라는 낱말로 남아 있어야 하고,
  //   그것까지 금지하면 «이유를 지워야 통과하는» 테스트가 된다.
  const at = CODE.indexOf("function settingsSub(");
  assert.ok(at > 0, "settingsSub 가 없다");
  const body = CODE.slice(at, CODE.indexOf("\n}", at));
  assert.doesNotMatch(body, /보관|나가기/,
    "★ 부제가 아직 '보관/나가기' 를 말한다 — 열면 없다(규칙을 바꾸면 그 규칙을 설명하던 문장도 늙는다)");
});

test("E10/E11 0개 상태를 말하고, 나간 뒤 목록을 다시 읽는다", () => {
  assert.match(CODE, /rows\.length \? null : hint\(/,
    "★ 워크스페이스가 하나도 없을 때 아무 말도 안 한다 — 빈 목록은 «고장났다»로 읽힌다");
  const at = RAIL.indexOf("async function afterExit(");
  assert.ok(at > 0, "afterExit 이 없다");
  const body = RAIL.slice(at, at + 400);
  assert.match(body, /await refreshSpaces\(\)/,
    "★ 나간 뒤 목록을 다시 안 읽는다 — 방금 나온 워크스페이스가 그대로 남아 있다");
  assert.match(body, /if \(slug === activeWorkspaceSlug\(\)\) switchWorkspace\('primary'\)/,
    "지금 보고 있던 곳을 나갔는데 그 자리에 그대로 있는다");
});
