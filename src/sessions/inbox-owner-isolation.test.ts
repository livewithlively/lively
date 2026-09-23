// #1875 사용자별 격리 — 「확인할 것」에 **남의 세션**이 서던 것. 2026-08-27 장원준 신고:
//  *"내 팀워크스페이스에 있는 다른 사람이 만든 세션에서 그 사람이 확인할 것도 내가 확인할 것중에 하나로 뜬다."*
//
// 왜 생겼나 — 세션 목록은 내 것만 오지 않는다. 프로젝트 세션은 로그인한 전원에게 공개고(#452), 초대받은
//  세션도 온다. 그런데 「확인할 것」의 '답을 기다려요' 구획은 `stateKey === 'waiting'` 만 보고 세어서,
//  **동료가 답해야 할 세션**이 내 목록·내 배지에 섰다. 바로 옆 '끝났어요' 구획엔 `&& s.owned` 가 있었으므로
//  같은 화면 안에서 두 구획의 규칙이 갈려 있었다 — 빠뜨림이 곧 누수인 전형적인 자리다.
//
// 워크스페이스 축(#1875 §정정, session-workspace-isolation.test.ts)과 **직교**다: 워크스페이스 필터를
//  통과한 뒤에도 같은 워크스페이스 안 동료의 세션은 여전히 목록에 있다. 그 축은 서버가(gw_session_map),
//  이 축은 화면이 진다 — 목록 자체는 '보여야' 하고(사이드바·프로젝트 화면) 「확인할 것」만 '내 것'이어야 한다.
//
// ── 엣지 표(입력 × 기대) ────────────────────────────────────────────────────
//   E1 waiting · 내 것            → 뜬다
//   E2 waiting · 동료의 프로젝트 세션 → 안 뜬다   ★신고의 핵심
//   E3 done(미확인) · 내 것        → 뜬다
//   E4 done · 남의 것             → 안 뜬다
//   E5 owned 없음 + raw.owner==나  → 뜬다        (구 응답·노드 raw 폴백)
//   E6 owned 없음 + owner 부재/타인 → 안 뜬다     (fail-closed)
//   E7 (#4180 이후) 「확인할 것」은 세션을 세지 않는다 — 옛 배지 셈(inboxN·railCounts.inbox)이 되살아나지 않는다
//   E8 waiting 을 «나를 기다리는 것» 뜻으로 세는 **새 자리**가 생겨도 규칙을 지난다(홈 머리줄 «답 기다림» 등)
//
// ── #4180 (2026-09-21 회의) 뒤의 뜻 ──
//  「확인할 것」에서 세션 대기·완료 줄을 걷었다 — 그 화면·사이드바 구획·레일 배지는 더 세션을 세지 않는다. 남는 것은
//  술어 한 벌(isMineSess)과, 그 술어를 지나야 하는 자리(홈 머리줄 «답 기다림» · 세션 옮기기 canMoveSession). 알림 행의
//  소유 격리는 서버가 진다(org/store/app-notifications 가 member_id 로 고정) — 그건 그 스토어의 시험이 맡는다.
//
// ── 왜 소스 구조 단언인가 ───────────────────────────────────────────────────
//  web/ 는 dist 로 가지 않는다(web/tsconfig rootDir=web · 러너는 dist/**/*.test.js 만 수집). 그래서
//  화면 규칙은 **소스를 읽어** 잠근다 — 레포 선례: session-workspace-isolation.test.ts E7(terminal/routes.ts),
//  terminal/ai-login.test.ts(web/v2/onboarding.ts). E1~E6 은 술어 한 벌(isMineSess)에 모아 두고 그 술어의
//  본문을 여기서 직접 평가해 엣지를 전수로 판정한다(문자열 매칭이 아니라 **행위**로).
import { strict as assert } from "node:assert";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function repoRoot(): string {
  let d = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(path.join(d, "package.json"))) return d;
    d = path.dirname(d);
  }
  throw new Error("레포 뿌리를 찾지 못했다");
}
const readSrc = (rel: string): string => readFileSync(path.join(repoRoot(), rel), "utf8");
const VIEWS = readSrc("web/v2/views.ts");
const SIDE = readSrc("web/v2/side.ts");
const MAIN = readSrc("web/v2/main.ts");
const DOCS = readSrc("web/docs-content.ts");

/** 소유 술어를 **화면 소스에서 그대로 떼어** 실행한다 — 여기 사본을 두면 그 사본만 맞고 화면은 틀릴 수 있다. */
function loadIsMine(): (s: Record<string, unknown>, meId: string) => boolean {
  const m = /export const isMineSess = \(s: Sess\): boolean => \{([\s\S]*?)\n\};/.exec(VIEWS);
  assert.ok(m, "views.ts 에서 isMineSess 본문을 찾지 못했다 — 「확인할 것」의 소유 판정이 한 벌이 아니다");
  const body = m![1]
    .replace(/String\(\(state\.me && \(state\.me as \{ userId\?: string \}\)\.userId\) \|\| ''\)/g, "__ME__")
    .replace(/:\s*string/g, "");
  // eslint-disable-next-line no-new-func
  return new Function("s", "__ME__", `${body}`) as (s: Record<string, unknown>, meId: string) => boolean;
}

const ME = "jang";
const SESS = (o: Record<string, unknown>): Record<string, unknown> => ({ owned: false, raw: {}, ...o });

test("★ E1~E6 소유 술어(isMineSess)가 엣지를 전수로 가른다", () => {
  const isMine = loadIsMine();
  // E1/E3 — 서버가 owned 로 못 박아 준 내 세션
  assert.equal(isMine(SESS({ owned: true, raw: { owner: ME } }), ME), true, "E1/E3 내 세션이 빠진다");
  // E2/E4 — 동료 세션(프로젝트 공개로 목록엔 오지만 내 「확인할 것」은 아니다)
  assert.equal(isMine(SESS({ owned: false, raw: { owner: "yoon" } }), ME), false, "E2/E4 ★남의 세션이 내 「확인할 것」에 선다");
  // E5 — owned 가 안 실린 구 응답·노드 raw 행: owner 대조로 되찾는다
  assert.equal(isMine(SESS({ raw: { owner: ME } }), ME), true, "E5 owned 미탑재 내 세션이 빠진다");
  // E6 — 소유를 알 수 없으면 내 것이 아니다(fail-closed: 모르는 세션을 내 할 일로 세는 쪽이 더 나쁘다)
  assert.equal(isMine(SESS({ raw: {} }), ME), false, "E6 소유 불명이 내 것으로 샌다");
  assert.equal(isMine(SESS({ raw: { owner: "" } }), ME), false, "E6 빈 owner 가 내 것으로 샌다");
  // 로그인 정보가 아직 없을 때(부팅 첫 그림)도 남의 것을 내 것으로 세지 않는다
  assert.equal(isMine(SESS({ raw: { owner: "yoon" } }), ""), false, "E6 me 미상일 때 남의 세션이 샌다");
});

const OWNS = /isMineSess\(|isMine\(/;

test("★ E2 (#4180) 「확인할 것」 화면은 세션을 세우지 않는다 — 알림 이력만 그린다 (web/v2/views.ts renderInbox)", () => {
  const body = VIEWS.slice(VIEWS.indexOf("export function renderInbox"), VIEWS.indexOf("export function projName"));
  assert.ok(body.length > 0, "renderInbox 본문을 찾지 못했다");
  assert.doesNotMatch(body, /stateKey === 'waiting'|stateKey === 'done'/,
    "「확인할 것」 화면에 세션 대기·완료 줄이 되살아났다 — 회의(2026-09-21)에서 뺀 것이다");
  assert.match(body, /loadNotifications\(\{[^}]*scope: 'inbox'/, "「확인할 것」 화면이 inbox 렌즈로 알림을 읽지 않는다");
});

test("★ E2 (#4180) 사이드바에 「확인할 것」 구획이 없다 (web/v2/side.ts)", () => {
  assert.doesNotMatch(SIDE, /function renderInboxSide/, "사이드바 「확인할 것」 구획이 되살아났다 — 홈의 종이 그 자리다");
  assert.doesNotMatch(SIDE, /'data-nav': 'inbox'/, "사이드바 고정 행 [확인할 것] 이 되살아났다");
});

test("★ E7 (#4180) 「확인할 것」 배지를 세션으로 세는 자리가 없다 — 안 읽은 수는 서버가 센다", () => {
  for (const [rel, src] of [["web/v2/side.ts", SIDE], ["web/v2/main.ts", MAIN]] as const) {
    const badges = src.split("\n").filter((l) => /inboxN|const inbox =/.test(l) && /\.filter\(/.test(l));
    assert.deepEqual(badges, [], `${rel} 에 세션을 세는 옛 「확인할 것」 배지 셈이 남아 있다`);
  }
  assert.match(MAIN, /startUnreadWatch\(\)/, "홈 종의 안 읽은 수 시계(startUnreadWatch)가 셸 부팅에 없다");
});

test("★ E8 'waiting' 을 「확인할 것」 뜻으로 세는 자리는 전부 소유를 본다 (새 자리가 생겨도 잡힌다)", () => {
  const misses: string[] = [];
  for (const [rel, src] of [["web/v2/views.ts", VIEWS], ["web/v2/side.ts", SIDE], ["web/v2/main.ts", MAIN]] as const) {
    for (const line of src.split("\n")) {
      if (!/stateKey === 'waiting'/.test(line) || !/\.(filter|some)\(/.test(line)) continue;
      // 비대상: 프로젝트별 상태 집계·정렬 순위는 '누구 것이든 이 프로젝트에서 벌어지는 일'이라 소유 축이 아니다.
      if (/rank|SESS_STATES|c\.wait/.test(line)) continue;
      if (!OWNS.test(line)) misses.push(`${rel}: ${line.trim()}`);
    }
  }
  assert.deepEqual(misses, [], "「확인할 것」 뜻으로 waiting 을 세는데 소유를 안 보는 자리가 있다");
});

test("E9 소유 판정은 한 벌뿐이다 — side.ts 가 제 사본을 되살리지 않는다", () => {
  assert.match(SIDE, /isMineSess/, "side.ts 가 views.ts 의 isMineSess 를 쓰지 않는다");
  assert.doesNotMatch(SIDE, /const isMine = \(s: Sess\): boolean => !!s\.owned \|\|/,
    "side.ts 에 소유 판정 사본이 되살아났다 — 사본을 두면 배지와 목록이 다시 갈린다");
});

test("E10 사용설명서가 바뀐 규칙을 말한다 (화면과 문서가 갈리지 않게)", () => {
  const doc = DOCS.slice(DOCS.indexOf('slug: "inbox"'), DOCS.indexOf('slug: "projects"'));
  assert.ok(doc.length > 0, "설명서의 「확인할 것」 항목을 찾지 못했다");
  assert.doesNotMatch(doc, /보이는 세션 전부/, "설명서가 아직 '보이는 세션 전부'라고 말한다");
  //  #4180 — 설명서도 «세션은 여기 오지 않는다 · 종 · 댓글·언급·리브» 를 말해야 한다.
  assert.match(doc, /세션이 답을 기다리거나 끝난 것은 여기 오지 않습니다/, "설명서가 세션 알림을 뺀 것을 말하지 않는다");
  assert.match(doc, /종/, "설명서가 홈의 종을 말하지 않는다");
  assert.match(doc, /댓글/, "설명서가 댓글 알림을 말하지 않는다");
  assert.match(doc, /리브가 답했어요/, "설명서가 리브의 답 알림을 말하지 않는다");
});
