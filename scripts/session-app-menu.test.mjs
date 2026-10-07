// #4600 — 붙은 앱 탭의 ⋯ 메뉴 · 판 이력 · 방금 고침 띠 · 앱 찾기에서 빼기/다시 넣기(프로젝트 #4592 「장표 수정 앱」, 기획안 2판 05절).
//  S6-1 메뉴 줄 — 여섯 항목 + 구분선, 순서(고치는 길 → 보는 길 → 떼기), 할 수 없는 줄은 흐리게(힌트가 까닭을 말한다)
//  S6-2 「AI에게 고치기」 — 세션 입력칸을 채우는 사건(lively:compose-draft)을 보낸다 · 글은 「<앱> 앱을 이렇게 고쳐 줘: 」 · 보내지 않는다
//  S6-3 'updated' 사건 — 붙은 앱 화면을 다시 띄우고(1회) 띠를 세운다 · 띠 글 · 「되돌리기」는 바로 앞 판
//  S6-4 판 이력 — 지금 판은 누를 수 없고 앞 판/원본 판정 · 줄 모양
//  S6-5 앱 찾기 빼기/넣기 — 토글 왕복 · 칸 열쇠(화면 앱 ≠ 설치 앱) · 뺀 칸은 검색 중이 아니면 아래 묶음, 검색 중엔 제 자리에 표시
//  S6-6 배선 — 줄 맨 앞의 실제 코드만 인정한다(주석 속 이름으로 통과하지 않게, scripts/session-app-pane.test.mjs S10 과 같은 수법)
//
//  ⚠ 순수 판정은 컴파일 결과(public/app/lib/*)를 그대로 돌린다 — DOM 을 모르는 잎이라 흉내가 필요 없다. 그리는 쪽은 배선 검사로만.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0;
const ok = (cond, name) => { assert.ok(cond, name); pass++; console.log(`ok  ${name}`); };
const eq = (got, want, name) => { assert.deepEqual(got, want, `${name}: ${JSON.stringify(want)} 여야 하는데 ${JSON.stringify(got)}`); pass++; console.log(`ok  ${name}`); };

const menu = await import(join(root, "public/app/lib/app-menu.js"));
const pad = await import(join(root, "public/app/lib/pad-hidden.js"));

// ══ S6-1 메뉴 줄 ══════════════════════════════════════════════════════════════
{
  const calls = [];
  const h = Object.fromEntries(["edit", "prefs", "versions", "original", "big", "detach"].map((k) => [k, () => calls.push(k)]));
  const rows = menu.sessAppMenuRows({ title: "장표 수정", hasFrame: true, overridesBuiltin: true, versionNo: 3 }, h);
  eq(rows.map((r) => (r.sep ? "—" : r.label)), ["AI에게 고치기…", "표시 설정", "판 이력…", "원본으로 되돌리기", "—", "크게 보기", "이 세션에서 떼기"], "S6-1 여섯 항목 + 구분선, 고치는 길 → 보는 길 → 떼기 순서");
  rows.filter((r) => r.run).forEach((r) => r.run());
  eq(calls, ["edit", "prefs", "versions", "original", "big", "detach"], "S6-1 줄마다 제 손잡이를 부른다");
  ok(rows[rows.length - 1].danger === true && !rows[0].danger, "S6-1 떼기만 위험색(맨 아래 관례)");
  eq(rows[2].hint, "3판", "S6-1 판 이력 줄의 힌트는 지금 판 번호");
  const bare = menu.sessAppMenuRows({ title: "x", hasFrame: false, overridesBuiltin: false, versionNo: null }, h);
  eq([bare[1].off, bare[3].off, bare[2].hint], [true, true, undefined], "S6-1 화면이 없으면 표시 설정이, 원본 그대로면 「원본으로」가 흐려진다 · 판을 모르면 힌트 없음");
  ok(/앱 화면이 없음/.test(bare[1].hint) && /지금이 원본/.test(bare[3].hint), "S6-1 흐린 줄은 힌트가 까닭을 말한다");
}

// ══ S6-2 「AI에게 고치기」 글 ═══════════════════════════════════════════════════
{
  eq(menu.draftTextFor("장표 수정"), "「장표 수정」 앱을 이렇게 고쳐 줘: ", "S6-2 입력칸에 채우는 글 — 뒤를 사람이 잇는 열린 문장");
  ok(!/보내|send/.test(menu.draftTextFor("x")), "S6-2 채우기만 한다(글에 보내기 없음)");
}

// ══ S6-3 방금 고침 띠 ══════════════════════════════════════════════════════════
{
  eq(menu.bandText({ version_no: 2, note: "글 줄 칸을 아래로" }), "2판 · 방금 고침 · 글 줄 칸을 아래로", "S6-3 띠 글 — 판 · 방금 고침 · 요지");
  eq(menu.bandText({}), "방금 고침", "S6-3 판·요지를 모르면 「방금 고침」만");
}

// ══ S6-4 판 이력 판정 ══════════════════════════════════════════════════════════
{
  const V = [
    { version_no: 3, origin: "member", version: "1.0.0", note: "보낸 줄 접기", saved_by: "원준", saved_at: "2026-10-07T07:30:00Z", is_current: true },
    { version_no: 2, origin: "member", version: "1.0.0", note: "글 줄 칸을 아래로", saved_by: "원준", saved_at: "2026-10-07T07:02:00Z", is_current: false },
    { version_no: 1, origin: "builtin", version: "1.0.0", note: null, saved_by: null, saved_at: "2026-10-07T06:00:00Z", is_current: false },
  ];
  eq(menu.previousVersionNo(V), 2, "S6-4 되돌리기 = 지금 판의 바로 앞 판");
  eq(menu.previousVersionNo([V[2]].map((v) => ({ ...v, is_current: true }))), null, "S6-4 판이 하나면 앞 판 없음");
  eq(menu.previousVersionNo([...V].reverse()), 2, "S6-4 순서가 깨져 있어도 번호로 고른다");
  eq(menu.originVersionNo(V), 1, "S6-4 원본 판 = origin builtin 가운데 가장 앞");
  eq(menu.originVersionNo(V.slice(0, 2)), null, "S6-4 빌트인에서 갈라지지 않은 앱은 원본 판이 없다");
  const reverted = [];
  const rows = menu.versionRows([...V].reverse(), (n) => reverted.push(n));
  eq(rows.map((r) => r.label), ["3판 · 보낸 줄 접기", "2판 · 글 줄 칸을 아래로", "1판 · 라이블리 기본 앱"], "S6-4 줄은 최신 먼저 · 원본 판은 「라이블리 기본 앱」");
  eq([rows[0].off, rows[0].hint, rows[1].off], [true, "지금", false], "S6-4 지금 판은 누를 수 없고 「지금」");
  ok(/원본 · 릴리스 1\.0\.0/.test(rows[2].hint), "S6-4 원본 판의 힌트는 릴리스 판 번호");
  rows[1].run(); rows[2].run();
  eq(reverted, [2, 1], "S6-4 줄을 누르면 그 판으로");
  ok(rows[0].run === undefined, "S6-4 지금 판에는 누를 손잡이가 없다");
}

// ══ S6-5 앱 찾기 빼기/다시 넣기 ═══════════════════════════════════════════════════
{
  eq([pad.padTileId("screen", "deck-edit"), pad.padTileId("installed", "deck-edit")], ["deck-edit", "i:deck-edit"], "S6-5 화면 앱과 설치 앱은 같은 이름이라도 다른 칸");
  const a = pad.padHiddenToggle([], "i:deck-edit");
  const b = pad.padHiddenToggle(a, "projects2");
  const c = pad.padHiddenToggle(b, "i:deck-edit");
  eq([a, b, c], [["i:deck-edit"], ["i:deck-edit", "projects2"], ["projects2"]], "S6-5 빼기 → 또 빼기 → 다시 넣기 왕복(순서는 뺀 차례)");
  const hidden = new Set(["i:deck-edit"]);
  eq([pad.padPlacement("projects2", hidden, false), pad.padPlacement("i:deck-edit", hidden, false), pad.padPlacement("i:deck-edit", hidden, true)],
    ["group", "hidden", "group-marked"], "S6-5 안 뺀 칸은 제 묶음 · 뺀 칸은 아래 묶음 · 검색 중엔 제 자리에 표시로");
}

// ══ S6-6 배선 ═══════════════════════════════════════════════════════════════════
{
  const read = (p) => readFileSync(join(root, p), "utf8");
  const PANE = read("web/v2/session-app-pane.ts");
  const APPS = read("web/v2/apps.ts");
  const UI = read("web/v2/app-ui.ts");
  const LIVE = read("web/v2/live-sync.ts");
  const VER = read("web/v2/app-versions.ts");
  ok(/^export const COMPOSE_DRAFT_EVT = 'lively:compose-draft';/m.test(PANE) && /^\s*window\.dispatchEvent\(new CustomEvent\(COMPOSE_DRAFT_EVT, \{ detail: \{ session, text \} \}\)\);/m.test(PANE), "S6-2 「AI에게 고치기」는 셸 창 사건 lively:compose-draft {session, text} 로 간다(세션 대화 화면이 받는다)");
  ok(/^\s*edit: \(\) => \{ composeDraft\(s, draftTextFor\(cur\.title\)\);/m.test(PANE), "S6-2 메뉴의 고치기 줄이 그 세션에 초안 글을 보낸다");
  ok(/^\s*prefs: \(\) => \{ mounted\?\.frame\?\.notify\('ui\/notifications\/prefs-open', \{\}\); \},/m.test(PANE), "S6-1 「표시 설정」은 앱에 prefs-open 알림(SPEC §1-1)");
  ok(/^\s*big: \(\) => \{ void openAppUi\(cur\.app_id, \{ title: cur\.title, sessionId: s, page: cur\.pages\[0\]\?\.key \}\); \},/m.test(PANE), "S6-1 「크게 보기」는 같은 세션에 붙은 채로 크게 띄운다");
  ok(/opts\?: \{ page\?: string; title\?: string; sessionId\?: string \}\): Promise<boolean>/.test(UI), "S6-1 openAppUi 가 sessionId 를 받는다(mountAppUiFrame 으로 그대로)");
  ok(/kind: 'attach' \| 'detach' \| 'data' \| 'updated';/.test(LIVE), "S6-3 앱 사건 타입에 updated");
  const upd = (PANE.match(/if \(ev\.kind === 'updated'\) \{[\s\S]*?\n    \}/) || [""])[0];
  ok((upd.match(/m\.frame\.reload\(\);/g) || []).length === 1 && /showBand\(cur, ev\);/.test(upd) && /^\s*return;$/m.test(upd), "S6-3 updated → 그 앱 화면 다시 띄우기 1회 + 띠, 데이터 분기로 안 내려간다");
  ok(/bandTimer = window\.setTimeout\(\(\) => \{ bandTimer = 0; band\.hidden = true; \}, 60_000\);/.test(PANE), "S6-3 띠는 60초 뒤 걷힌다");
  ok(/onclick: \(\) => \{ void revertToPrevious\(cur\.app_id, cur\.title\); \}/.test(PANE), "S6-3 띠의 「되돌리기」 = 바로 앞 판");
  ok(/^\s*root\.append\(tabs, head, band, body\);/m.test(PANE) && /^\s*paintHead\(cur\);/m.test(PANE), "S6-1 머리줄은 탭 줄 아래 · 앱이 하나여도 그린다(paint 마다)");
  ok(/appPath\(appId, '\/versions'\)/.test(VER) && /appPath\(appId, '\/revert'\), \{ method: 'POST', body: JSON\.stringify\(\{ version_no: versionNo \}\) \}/.test(VER), "S6-4 판 이력 · 되돌리기는 SPEC §1-3 경로(GET /versions · POST /revert {version_no})");
  ok(/^export const PAD_HIDDEN_STORE = shellPrefStore\('lively_v2_pad_hidden', 'list'\);/m.test(APPS) && /^\s*shellPrefsPush\(\);\s*$/m.test((APPS.match(/export function togglePadHidden[\s\S]*?\n\}/) || [""])[0]), "S6-5 뺀 목록은 계정의 것(shell-prefs — 최근 앱과 같은 길)");
  ok(/padPlacement\(t\.tid, hidden, !!q\) !== 'hidden'/.test(APPS) && /padPlacement\(t\.tid, hidden, !!q\) === 'hidden'/.test(APPS), "S6-5 격자는 순수 판정(padPlacement)으로 가른다");
  ok(/class: 'v2-pad-sec v2-pad-hid'/.test(APPS) && /text: `뺀 앱 \$\{gone\.length\}`/.test(APPS), "S6-5 뺀 칸은 격자 아래 접힌 「뺀 앱 N」 묶음");
  ok(/'\.v2-pad-item, \.v2-pad-top, \.v2-pad-sec-h, \.v2-pad-hid-note, \.pn-ctx'/.test(APPS), "S6-5 뺀 묶음의 머리·안내·메뉴를 눌러도 앱 찾기가 닫히지 않는다");
  ok(/node\.addEventListener\('contextmenu', \(e\) => \{ e\.preventDefault\(\); e\.stopPropagation\(\); menu\(e\.clientX, e\.clientY\); \}\);/.test(APPS) && /class: 'v2-pad-more'/.test(APPS), "S6-5 칸의 우클릭과 ⋯ 가 같은 메뉴(빼기/다시 넣기)");
  const DOCS = read("web/docs-content.ts");
  ok(/「목록에서 빼기」로 격자에서 치웁니다/.test(DOCS) && /「다시 넣기」로 언제든 돌려 둡니다/.test(DOCS), "사용 가이드 「앱」에 빼기·다시 넣기 한 줄");
}

console.log(`\n${pass} passed`);
process.exit(0);
