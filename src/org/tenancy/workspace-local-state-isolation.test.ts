// #1875 — **브라우저에 저장된 화면 상태**의 워크스페이스 격리. 2026-08-27 장원준 신고:
//  *"왜 사이드바에 내가 그 워크스페이스에서 안 만든 게 있는지 봐봐. 내가 새 워크스페이스 만든 다음에
//   사이드바는 깨끗하고 아무것도 없어야 할 거 아니야."*
//
// ── 무엇이 사실이었나(2026-08-27 dev 실측 재현) ─────────────────────────────
// 서버는 이미 갈라 준다 — 새 워크스페이스에서 `/api/ui/terminal/sessions`·`/api/ui/v6/sessions`·
//  `/api/ui/v6/projects`·`/api/ui/app-instances` 가 전부 0을 돌려준다(네트워크 응답으로 확인).
//  그런데 팀 워크스페이스에서 세션 두 개를 연 뒤 새 워크스페이스로 전환하니 사이드바에 그 두 행이 그대로 섰다:
//    sess:box-yoon-72399d78 → '세션 이름 자동화'   ·   sess:box-yoon-ef5009c0 → '머지 및 데브 반영'
//
// 원인은 **화면의 기억**이었다. 사이드바 목록의 셋째 줄기(main.ts sideInstances ③ '지금 열린 창')는
//  `force=true` 로 서버 데이터를 보지 않고 행을 세운다 — 그 규칙 자체는 옳다("보고 있는 화면이 목록에
//  없으면 그게 고장이다"). 틀린 것은 그 **창 목록(localStorage 'lively_v2_tabs')이 워크스페이스를 안
//  나눈 것**이다. 탭·고정·최근 앱·이름 캐시 30여 개가 전부 브라우저에 한 벌로 살았다.
//
// ── 고친 방식 ───────────────────────────────────────────────────────────────
// `web/lib/net.ts` 의 `wsKey(base)` 한 곳에서 키를 만든다 — primary 는 접미사 없음(기존 기억 보존),
//  그 밖은 `키@슬러그`(새 워크스페이스는 처음부터 비어 있다 = 깨끗하다).
//
// ── 엣지 표(입력 × 기대) ────────────────────────────────────────────────────
//   E1 [선택 없음]        → 접미사 없음   (구 클라이언트·첫 방문 — 기존 기억을 잃지 않는다)
//   E2 ['primary']       → 접미사 없음   (primary = 무컨텍스트 규약과 일치)
//   E3 ['ws-a7c2f76f']   → '키@ws-a7c2f76f'
//   E4 [다른 개인 ws]     → E3 과 **다른** 키 (개인↔개인도 갈린다)
//   E5 대소문자·공백      → currentWorkspace() 가 정규화한 값을 그대로 쓴다(한 벌만 생긴다)
//   E6 워크스페이스 내용을 담는 저장소 키가 **하나라도** 맨 문자열로 남아 있으면 실패(빠뜨림 = 누수)
//   E7 같은 키를 두 파일이 각자 적으면 실패 — 한쪽에만 접미사가 붙어 그 화면만 남의 기록을 본다
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
const ROOT = repoRoot();
const readSrc = (rel: string): string => readFileSync(path.join(ROOT, rel), "utf8");
const NET = readSrc("web/lib/net.ts");

/** wsKey 본문을 **소스에서 그대로 떼어** 실행한다 — 테스트에 사본을 두면 그 사본만 맞을 수 있다. */
function loadWsKey(): (base: string, ws: string) => string {
  const m = /function wsKey\(base: string\): string \{([\s\S]*?)\n\}/.exec(NET);
  assert.ok(m, "web/lib/net.ts 에서 wsKey 를 찾지 못했다 — 워크스페이스별 저장소 키의 단일 자리가 없다");
  const body = m![1].replace(/currentWorkspace\(\)/g, "__WS__").replace(/:\s*string/g, "");
  // eslint-disable-next-line no-new-func
  return new Function("base", "__WS__", body) as (base: string, ws: string) => string;
}

test("★ E1~E5 wsKey 가 워크스페이스별로 다른 자리를 준다", () => {
  const k = loadWsKey();
  assert.equal(k("lively_v2_tabs", ""), "lively_v2_tabs", "E1 선택 없음인데 접미사가 붙는다 — 기존 사용자의 기억이 통째로 날아간다");
  assert.equal(k("lively_v2_tabs", "primary"), "lively_v2_tabs", "E2 primary 에 접미사가 붙는다(무컨텍스트 규약 위반)");
  const a = k("lively_v2_tabs", "ws-a7c2f76f");
  const b = k("lively_v2_tabs", "ws-255aec46");
  assert.notEqual(a, "lively_v2_tabs", "E3 ★새 워크스페이스가 primary 와 같은 자리를 쓴다 — 사이드바에 남의 워크스페이스 것이 선다");
  assert.notEqual(a, b, "E4 개인 워크스페이스끼리 같은 자리를 쓴다");
  assert.ok(a.includes("ws-a7c2f76f"), "E3 키에 워크스페이스가 안 들어간다");
  // E5 — 정규화는 currentWorkspace() 의 몫이다(소문자·trim). wsKey 는 받은 값을 그대로 쓴다.
  assert.match(NET, /localStorage\.getItem\(WORKSPACE_KEY\)[^\n]*\.trim\(\)\.toLowerCase\(\)/,
    "currentWorkspace() 가 정규화를 안 한다 — 대소문자만 다른 키가 두 벌 생긴다");
});

// ── E6 — 워크스페이스의 **내용**(세션·프로젝트·앱·리스트 id)을 담는 저장소는 전부 wsKey 를 지난다 ──
//  '취향'(테마·글꼴·나눔선 폭·필터 토글·레일 열림·가이드 완료)은 대상이 아니다 — 그것까지 나누면 워크스페이스를
//  옮길 때마다 사람이 설정을 다시 해야 한다. 격리의 목적은 **남의 내용이 안 보이는 것**이지 취향을 잃는 것이 아니다.
const SCOPED: Array<[string, string]> = [
  ["web/v2/tabs.ts", "lively_v2_tabs"],                    // ★신고의 직접 원인 — 열린 창 목록
  ["web/v2/side.ts", "lively_v2_opened"],
  ["web/v2/side.ts", "lively_v2_side_pin"],
  ["web/v2/side.ts", "lively_v2_app_pin"],
  ["web/v2/side.ts", "lively_v2_side_selclosed"],
  ["web/v2/side.ts", "lively_v2_side_group"],
  ["web/v2/side.ts", "lively_v2_side_grpclosed"],
  ["web/v2/side.ts", "lively_v2_side_grpopened"],
  ["web/v2/side.ts", "lively_v2_proj_fold_closed"],
  ["web/v2/side.ts", "lively_v2_proj_fav_top"],
  ["web/v2/side.ts", "lively_v2_wiki_closed"],
  ["web/v2/apps.ts", "lively_v2_recent_apps"],
  ["web/v2/rail.ts", "lively_v2_rail_main"],
  ["web/v2/rail.ts", "lively_v2_rail_pins"],
  ["web/v2/rail.ts", "lively_v2_rail_hidden"],
  ["web/v2/main.ts", "lively_v2_sess_names"],
  ["web/v2/main.ts", "lively_v2_side_dismissed"],
  ["web/v2/main.ts", "lively_v2_home_route"],
  ["web/v2/last-ask.ts", "lively_v2_last_ask"],
  ["web/v2/notifications.ts", "lively_v2_notified"],
  ["web/v2/panes.ts", "lively_panes_layout_v2"],
  ["web/dash/prefs.ts", "dash_list_order_v1"],
  ["web/dash/prefs.ts", "dash_ov_hidden_v1"],
  ["web/dash/prefs.ts", "dash_ov_pinned_v1"],
];

test("★ E6 워크스페이스의 내용을 담는 저장소 키는 전부 wsKey 를 지난다", () => {
  const bad: string[] = [];
  for (const [rel, key] of SCOPED) {
    const src = readSrc(rel);
    const line = src.split("\n").find((l) => l.includes(`'${key}'`) && /=|getItem|setItem/.test(l));
    if (!line) { bad.push(`${rel}: '${key}' 선언을 찾지 못했다(이름이 바뀌었으면 이 표도 함께 고쳐라)`); continue; }
    if (!/wsKey\(/.test(line)) bad.push(`${rel}: ${line.trim()}`);
  }
  assert.deepEqual(bad, [], "워크스페이스 내용을 담는데 wsKey 를 안 지나는 저장소가 있다 — 그 자리가 새 워크스페이스로 새어 나온다");
});

test("★ E7 스코프 대상 키를 두 파일이 각자 적지 않는다(한쪽만 접미사가 붙는 사고 방지)", () => {
  const FILES = ["web/v2/tabs.ts", "web/v2/side.ts", "web/v2/main.ts", "web/v2/apps.ts", "web/v2/rail.ts",
    "web/v2/last-ask.ts", "web/v2/notifications.ts", "web/v2/panes.ts", "web/dash/prefs.ts"];
  const dup: string[] = [];
  for (const [, key] of SCOPED) {
    const owners = FILES.filter((f) => readSrc(f).includes(`'${key}'`));
    if (owners.length > 1) dup.push(`${key} → ${owners.join(", ")}`);
  }
  assert.deepEqual(dup, [], "같은 저장소 키를 여러 파일이 각자 적고 있다 — 한 곳에서 export 해 쓰게 하라");
});

test("E8 취향 저장소는 워크스페이스로 나누지 않는다(과잉 격리 방지)", () => {
  // 이 키들이 wsKey 를 타면 워크스페이스를 옮길 때마다 테마·폭·레일이 초기화된다 — 사람이 손해만 본다.
  const PREF_KEYS: Array<[string, string]> = [
    ["web/v2/split.ts", "lively_v2_split_"],
    ["web/guide-tour.ts", "lively_gtour_done_sections_v1"],
  ];
  for (const [rel, key] of PREF_KEYS) {
    const line = readSrc(rel).split("\n").find((l) => l.includes(`'${key}'`)) ?? "";
    assert.doesNotMatch(line, /wsKey\(/, `${rel} 의 '${key}' 는 기기·사람 취향이라 워크스페이스로 나누면 안 된다`);
  }
});
