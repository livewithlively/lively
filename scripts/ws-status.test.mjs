// 워크스페이스 메뉴 — 행 상태와 «지금» 얼굴 열쇠 (#3778 태스크 #4122, 원준 2026-09-21)
//
// 신고 셋(원문 요지):
//  ① «준비 중이에요 — 곧 열립니다 → 오프라인», 지금 켜진 곳엔 «온라인» 표시가 필요하다.
//  ② «워크스페이스 설정에서 팀 네모난 아바타를 바꿔도 레일에서는 적용이 안 된다.»
//  ③ «이름·아바타는 이 워크스페이스를 만든 분이 바꿉니다 → 공동 관리자도. 권한은 만든 사람과 똑같이.»
//
// ── 엣지 표 ─────────────────────────────────────────────────────────────────
//  S1 running → 온라인(on)            S2 stopped → 오프라인(off) · «누르면 켜고 들어간다» 를 말한다
//  S3 provisioning → 만드는 중(wait)   S4 error·deleting·모르는 값 → 오프라인(off)
//  S5 null·undefined·'' → 표시 없음(셀프호스트 — 전 행 «온라인» 은 소음)
//  S6 어느 문구에도 대시(—)가 없다
//  K1 ★매니지드(is_current 를 실은 목록) → 참인 행의 slug        (종전: 늘 'primary' → 얼굴을 못 찾음)
//  K2 매니지드인데 참인 행이 없다 → null(모르는 것을 fallback 으로 메우지 않는다 — 남의 얼굴을 빌린다)
//  K3 셀프호스트(아무 행도 is_current 가 없다) → fallback(브라우저가 고른 값)
//  K4 is_current:false 만 실려도 매니지드로 본다 → null (fallback 'primary' 로 새지 않는다)
//  K5 빈 목록 → fallback
//  W0 새로 들인 열쇠가 비었을 때(목록을 아직 못 받음) → 종전대로 브라우저가 고른 값
//  W1 ★문패 얼굴 열쇠(ws().slug)가 목록의 «지금» 행을 먼저 본다   W2 목록을 받을 때 그 열쇠를 정한다
//  W3 ★저장하면 남겨 둔 얼굴도 고친다(안 고치면 새로고침 첫 그리기가 옛 얼굴)
//  W4 메뉴 행이 상태 판정을 lib 에서 가져다 쓴다 · 옛 문장이 없다
//  W5 워크스페이스 추가 부제가 «개인으로 만들고 초대하면 팀» 을 말한다
//  W6 ★메뉴가 사람에게 보이는 글자에 대시(—)가 없다(주석 제외)
//  W7 ★설정 창이 «만든 분이 바꿉니다» 대신 공동 관리자를 말하고, 자격 판정은 역할(owner)로 한다
//
// web/v2/* 는 DOM·core 에 묶여 유닛으로 못 몬다 — 판정은 lib/ws-status 로 빼서 값으로, 배선은 소스로 본다.
//  배선 단언이 «문자열이 있다» 에 그치지 않게 **식의 모양**(무엇이 무엇보다 먼저인가)까지 본다.
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
let pass = 0;
const ok = (cond, what) => { assert.ok(cond, what); pass++; };
const eq = (got, want, what) => { assert.deepEqual(got, want, what); pass++; };

const { wsStatus, currentRowSlug } = await import(join(root, "public/app/lib/ws-status.js"));

// ── 상태 한 칸 (S1~S6) ───────────────────────────────────────────────────────
eq([wsStatus("running")?.text, wsStatus("running")?.tone], ["온라인", "on"], "S1 켜져 있으면 «온라인»");
eq([wsStatus("stopped")?.text, wsStatus("stopped")?.tone], ["오프라인", "off"], "S2 절전은 «오프라인» — «준비 중» 이 아니다");
ok(/누르면 다시 켜고 들어갑니다/.test(wsStatus("stopped")?.title || ""), "S2 절전은 누르면 켜진다는 것을 말한다(입장 문이 깨운다)");
eq([wsStatus("provisioning")?.text, wsStatus("provisioning")?.tone], ["만드는 중", "wait"], "S3 갓 만든 것은 «만드는 중»");
for (const s of ["error", "deleting", "weird"]) eq([wsStatus(s)?.text, wsStatus(s)?.tone], ["오프라인", "off"], `S4 ${s} → 오프라인`);
for (const s of [null, undefined, ""]) eq(wsStatus(s), null, `S5 상태가 없으면(${JSON.stringify(s)}) 표시하지 않는다`);
for (const s of ["running", "stopped", "provisioning", "error"]) {
  const v = wsStatus(s);
  ok(!/—/.test(v.text + v.title), `S6 «${s}» 문구에 대시가 없다`);
}

// ── «지금» 행 열쇠 (K1~K5) ───────────────────────────────────────────────────
//  실측 모양(2026-09-21 원준 계정 /api/ui/me/workspaces) 그대로 — 셋 중 가운데가 지금.
const managed = [
  { slug: "wonjoon-jang-fd6a", is_current: false },
  { slug: "lively-46e3", is_current: true },
  { slug: "wonjoon-jang-074e", is_current: false },
];
eq(currentRowSlug(managed, "primary"), "lively-46e3", "K1 ★매니지드는 서버가 준 is_current 행이 «지금» 이다");
eq(currentRowSlug(managed.map((r) => ({ ...r, is_current: false })), "primary"), null, "K2 참인 행이 없으면 null");
eq(currentRowSlug([{ slug: "primary" }, { slug: "team-a" }], "team-a"), "team-a", "K3 셀프호스트는 브라우저가 고른 값");
eq(currentRowSlug([{ slug: "x", is_current: false }], "primary"), null, "K4 is_current 가 실렸으면 fallback 으로 새지 않는다");
eq(currentRowSlug([], "primary"), "primary", "K5 빈 목록이면 브라우저가 고른 값");

// ── 배선 (W0~W7) ─────────────────────────────────────────────────────────────
const strip = (src) => src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
const SW = strip(read("web/v2/switcher.ts"));
const RAIL = strip(read("web/v2/rail.ts"));
const MODAL = strip(read("web/v2/ws-settings.ts"));

ok(/let curRowKey: string \| null \| undefined;/.test(SW), "W0 열쇠의 «아직 모름»(undefined) 자리가 없다");
ok(/slug: curRowKey \?\? activeWorkspaceSlug\(\)/.test(SW),
  "W0/W1 ★문패 얼굴 열쇠가 목록의 «지금» 행을 먼저 보고, 모를 때만 고른 값으로 떨어져야 한다");
{
  const at = SW.indexOf("export async function listWorkspaces(");
  const body = SW.slice(at, SW.indexOf("\n}", at));
  ok(/curRowKey = currentRowSlug\(rows, activeWorkspaceSlug\(\)\)/.test(body), "W2 목록을 받을 때 «지금» 열쇠를 안 정한다");
  ok(body.indexOf("faceBySlug.clear()") < body.indexOf("rememberFaces("), "W2 남겨 두기가 지도를 새로 채우기 전에 돈다 — 옛 지도를 남긴다");
}
{
  const at = SW.indexOf("export async function saveWorkspaceSettings(");
  const body = SW.slice(at, SW.indexOf("\n}", at));
  ok(body.indexOf("await api(") >= 0 && body.indexOf("await api(") < body.indexOf("faceBySlug.set(slug, patch.face)"),
    "W3 ★저장이 성공한 뒤에 남겨 둔 얼굴을 고쳐야 한다(실패한 저장이 화면을 속이면 안 된다)");
  ok(/rememberFaces\(/.test(body), "W3 ★저장 뒤 남겨 둔 얼굴을 안 고친다 — 새로고침 첫 그리기가 옛 얼굴이다");
}
ok(/import \{ wsStatus \} from '\.\.\/lib\/ws-status\.js'/.test(RAIL) && /wsRowText\(w\)\)/.test(RAIL), "W4 메뉴 행이 상태 판정(wsStatus)을 안 쓴다");
//  «다중 워크스페이스 준비 중이에요(부팅 자동 활성화)» 는 다른 말(셀프호스트 활성화 대기)이라 남는다 — 걷은 문장만 본다.
ok(!RAIL.includes("곧 열립니다"), "W4 옛 문장 «준비 중이에요 — 곧 열립니다» 가 남았다");
ok(/row\('plus', '워크스페이스 추가', registryActive\(\) \? '개인 워크스페이스를 만들어요\. 사람을 초대하면 팀 워크스페이스가 됩니다\.'/.test(RAIL),
  "W5 워크스페이스 추가 부제가 «개인으로 만들고 초대하면 팀» 을 말하지 않는다");
{
  //  워크스페이스 메뉴 구역만(문패 타일 ~ 만들기 판). 레일의 다른 부품(독 툴팁 등)은 이 신고의 범위가 아니다.
  //  코드 줄 끝 주석(`… // 설명`)은 사람에게 안 보인다 — 따옴표·백틱 문자열만 본다.
  const raw = read("web/v2/rail.ts");
  const from = raw.indexOf("// ── 워크스페이스 — 스택 타일");
  const to = raw.indexOf("//  #2188 — 종전의 「워크스페이스 설정」 판");
  ok(from > 0 && to > from, "W6 배선 — 메뉴 구역 표지를 못 찾았다(구역이 비면 아래 단언이 공짜로 초록이 된다)");
  const lits = strip(raw.slice(from, to)).match(/'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g) || [];
  ok(lits.length > 40, "W6 배선 — 문자열을 제대로 못 뽑았다(추출이 죽으면 아래 단언이 공짜로 초록이 된다)");
  eq(lits.filter((s) => s.includes("—")), [], "W6 ★메뉴가 사람에게 보이는 글자에 대시(—)가 남았다");
}
ok(!MODAL.includes("만든 분이 바꿉니다"), "W7 ★«만든 분이 바꿉니다» 가 남았다 — 공동 관리자도 바꾼다");
ok(/만든 사람과 공동 관리자가 바꿀 수 있어요/.test(MODAL), "W7 설정 창이 공동 관리자를 말하지 않는다");
ok(/const owner = primary \? isAdmin\(\) : w\.role === 'owner';/.test(MODAL),
  "W7 자격 판정이 역할(owner = 만든 사람·공동 관리자)이 아니다 — 공동 관리자가 잠긴다");

console.log(`ws-status: ${pass} passed`);
