// #2188 워크스페이스 설정 모달 — 화면 구조 잠금 (2026-08-31 장원준)
//
// 지시: "워크스페이스 [팝오버] 밑에 설정 버튼 하나, 누르면 모달 — 격리된 각 워크스페이스에 각각
//  해야 하는 설정들(기능 + 아바타·이름·초대까지)을 거기서".
//
// web/ 은 dist 로 컴파일되지 않아 유닛으로 못 몬다 — 레포 선례대로 «빠지면 조용히 깨지는» 구조를
//  소스에서 못박는다(workspace-exit-ui.test.ts · managed-workspace-surface.test.ts).
//
// ── 엣지 표 ─────────────────────────────────────────────────────────────────
//   E1 ★팝오버에 설정 입구가 **모두에게** 있다     → owner 게이트가 남으면 구성원은 문이 없다(종전 상태)
//   E2 모달에 네 섹션이 있다(아바타·이름 / 구성원·초대 / 연결한 팀 / 기능 설정)
//   E3 ★저장된 얼굴이 파생보다 먼저다(workspaceFace) → 빠지면 정한 아바타가 그려지지 않는다
//   E4 ★색을 style 로 꽂기 전 화면도 hex 를 거른다   → 서버만 믿으면 화면이 style 주입의 마지막 문이 된다
//   E5 밝은 색엔 어두운 잉크(inkFor)               → 흰 배경에 흰 글자(다크모드 사고 #2232 의 결)
//   E6 목록 응답의 face 가 slug 지도에 남는다       → 문패(행 객체 없이 그림)가 저장된 얼굴을 못 찾는다
//   E7 primary 이름은 org 프로필로 간다             → workspace_update 로 보내면 서버가 400(조직 이름이므로)
//   E8 이름·아바타 폼은 자격 없으면 disabled        → 눌렀더니 403 나는 문을 그리지 않는다
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
const MODAL = read("web/v2/ws-settings.ts");
const SW = read("web/v2/switcher.ts");
const strip = (src: string): string => src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
const RAILC = strip(RAIL); const MODALC = strip(MODAL); const SWC = strip(SW);

test("★ E1 설정 입구가 팝오버에 모두에게 있다 — owner 게이트 없이", () => {
  //  ⚠ «줄 머리에서 시작»까지 본다 — `X ? row('gear'…) : null` 로 감싸는 돌연변이가 문자열 매칭만으로는
  //   통과했다(실측). 조건이 붙는 순간 누군가에겐 문이 사라진다.
  assert.match(RAILC, /\n\s*row\('gear', '워크스페이스 설정', '아바타 · 이름 · 구성원 · 기능 설정', \(\) => openCurrentWsSettings\(/,
    "★설정 입구가 없거나, 조건부로 감싸였거나, 부제·목적지가 다르다 — 모두에게 무조건 그려져야 한다");
});

test("E2 모달에 네 섹션이 있다", () => {
  for (const t of ["아바타 · 이름", "구성원 · 초대", "연결한 팀", "기능 설정"]) {
    assert.ok(MODALC.includes(t), `섹션이 없다: ${t}`);
  }
  assert.match(MODALC, /peopleSection\(w\.slug\)/, "구성원 덩어리(초대 폼 포함)를 심지 않는다 — '초대도 거기서' 가 빠진다");
  //  #1898 — 섹션을 **찍지 않는다**('#/system' 뒤에 슬래시 없음). 찍어 둔 섹션은 매니지드에서 숨을 수 있어
  //   (admin-shell PERSONAL_HIDDEN) 어디로 떨어질지 모르는 링크가 된다 — 섹션 없는 '#/system' 은
  //   renderAdmin 이 그 사람에게 보이는 첫 섹션으로 연다. 그러니 검사는 '문이 있나'까지다.
  assert.match(MODALC, /#\/system/, "기능 설정(관리탭)으로 가는 문이 없다");
});

test("★★ E3/E4/E5 저장된 얼굴 — 파생보다 먼저, hex 만, 밝으면 어두운 잉크", () => {
  const at = SW.indexOf("export function workspaceFace(");
  assert.ok(at > 0);
  const body = SW.slice(at, SW.indexOf("\n}", SW.indexOf("profileAvatar", at)));
  assert.ok(body.indexOf("w.face") < body.indexOf("profileAvatar"),
    "★저장된 얼굴 판정이 파생(profileAvatar)보다 뒤다 — 정한 아바타가 안 그려진다");
  assert.match(body, /HEX_RE\.test\(f\.color\)/,
    "★화면이 색을 style 로 꽂기 전에 hex 를 안 거른다 — 화면이 style 주입의 마지막 문이다");
  assert.match(body, /inkFor\(color\)/, "잉크색을 안 고른다 — 밝은 색 위 흰 글자(#2232 의 그 사고)");
  assert.match(SWC, /faceBySlug\.get\(w\.slug\)/, "행 객체 없이 그리는 자리(문패)가 얼굴을 찾을 길이 없다");
});

test("★ E6 목록 응답의 face 가 slug 지도에 남는다", () => {
  assert.match(SWC, /faceBySlug\.clear\(\);/, "지도를 안 비운다 — 지운 얼굴이 화면에 남는다");
  assert.match(SWC, /faceBySlug\.set\(String\(r\.slug\), r\.face\)/, "★목록의 face 를 지도에 안 남긴다");
});

test("★ E7/E8 primary 이름은 org 프로필로, 자격 없으면 폼이 잠긴다", () => {
  assert.match(MODALC, /if \(primary && nameChanged\) \{[\s\S]{0,300}\/api\/ui\/org\/profile/,
    "★primary 이름이 workspace_update 로 간다 — 서버가 400 을 낸다(조직 이름은 org 프로필)");
  assert.match(MODALC, /\.\.\.\(owner \? \{\} : \{ disabled: 'disabled' \}\)/, "자격 없는 사람에게 열린 폼을 그린다(눌렀더니 403)");
  //  떠나는 문 금지는 workspace-exit-ui.test.ts E9 가 잠근다(중복 단언을 두지 않는다).
});
