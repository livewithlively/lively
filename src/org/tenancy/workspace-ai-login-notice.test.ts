// #2476 — «AI 로그인은 워크스페이스마다 따로» 를 **참인 자리에서만** 말한다.
//
// ── 사양 ────────────────────────────────────────────────────────────────────
// 실측 2026-08-28(상민님): 새 워크스페이스에 들어가 «방금 로그인했는데 왜 또?». 매니지드는 워크스페이스
//  하나가 테넌트 하나이고(lvly-cloud `workspaces_tenant_uq` — 1:1 이 관행이 아니라 제약이다) 세션 컨테이너의
//  `/home` 은 그 테넌트 디렉터리의 `homes/` 에서 온다. 그래서 AI 자격이 사는 멤버 홈이 워크스페이스마다
//  새로 생기고, 저기서 이은 로그인은 여기로 따라올 길이 **구조적으로** 없다.
//  #2476 의 결정은 «자격을 옮긴다» 가 아니라 «미리 말한다» 였다 — 그래서 이 안내는 제품의 약속이다.
//
// ⚠ 그런데 이 문장은 **셀프호스트에서 거짓이다.** 거긴 `org_member` 가 워크스페이스를 넘나드는 전역 신원이고
//  (src/db/tenant-column.ts IDENTITY_GLOBAL_TABLES) OS 홈은 그 멤버 id 에서만 파생된다
//  (src/terminal/profiles.ts memberOsUser) — 워크스페이스를 몇 개 만들든 같은 `/home/box_<slug>` 를 쓰므로
//  자격이 애초에 안 사라진다. 거기에 이 안내를 띄우면 **없는 불편을 있다고 말하는 것**이고, 사람은 그 말을
//  믿고 쓸데없이 다시 로그인한다. 게이트가 조용히 빠져도 화면은 멀쩡히 그려지고 오류도 안 난다.
//
// ── 엣지 표(입력 × 기대) ────────────────────────────────────────────────────
//   E1 [매니지드, 만들기 패널]      → 문장이 있다
//   E2 [셀프호스트, 만들기 패널]    → **빈 문자열**(줄 자체를 안 그린다)
//   E3 [매니지드, 온보딩 로그인]    → 문장이 있다
//   E4 [셀프호스트, 온보딩 로그인]  → **빈 문자열**
//   E5 [매니지드, 두 자리]          → 둘 다 «한 번만/계속» 취지를 담는다(「따로다」만 말하면 놀람이 안 가신다)
//   E6 [새로 도입한 것의 부재]      → 화면이 판정을 안 거치고 문구를 직접 박으면 잡힌다
//   E7 [배선 부재]                  → 화면이 매니지드 여부를 안 넘기고 부르면(상수 등) 잡힌다
//
// ── 단언의 모양 ─────────────────────────────────────────────────────────────
// 문구 전문을 요구하지 않는다(구현과 같은 문자열을 요구하는 단언은 계약이 아니라 결함의 사본이다 — #2055).
//  관측하는 **부작용**은 «그려지나 / 안 그려지나» 다 — 빈 문자열이면 화면에 아무것도 안 선다.
//  판정 함수는 **소스에서 그대로 떼어 실행한다**(사본을 테스트에 두면 그 사본만 맞을 수 있다).
//  web 은 esbuild 로 따로 묶여 dist 에 안 가므로 import 로는 못 잡는다 — web/lib/net.ts 의 wsKey 를
//  같은 방식으로 재는 선례가 있다(workspace-local-state-isolation.test.ts).
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

/**
 * 문자열을 보는 단언은 **주석을 먼저 걷고** 봐야 한다 — 이 레포가 이미 하루에 세 번 헛걸린 자리다
 *  (#2055 §5: «왜 그렇게 안 하는지 설명한 주석»에 grep 게이트가 걸렸다). 여기서도 정확히 그랬다:
 *  화면 파일의 import 줄에 달아 둔 «…«워크스페이스마다 따로» 를 말할지…» 주석이 문구 사본으로 잡혔다.
 *  `://`(URL)은 건드리지 않는다.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n").map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1")).join("\n");
}

const SCOPE_SRC = "web/v2/ai-login-scope.ts";
const SCOPE = readSrc(SCOPE_SRC);

/** 판정 함수 본문을 **소스에서 떼어** 실행한다. 의존이 없으므로 타입만 걷으면 그대로 돈다. */
function loadFn(name: string): (managed: boolean) => string {
  const m = new RegExp(`export function ${name}\\(managed: boolean\\): string \\{([\\s\\S]*?)\\n\\}`).exec(SCOPE);
  assert.ok(m, `${SCOPE_SRC} 에서 ${name} 을 찾지 못했다 — 안내의 단일 자리가 사라졌다`);
  return new Function("managed", m![1]) as (managed: boolean) => string;
}

// ── E1~E4 — 참인 자리에서만 말한다 ──────────────────────────────────────────
const CASES: Array<[string, string, string]> = [
  ["aiLoginScopeHint", "만들기 패널", "E1/E2"],
  ["aiLoginScopeNote", "온보딩 «AI 연결» 로그인 화면", "E3/E4"],
];

for (const [fn, what, ids] of CASES) {
  test(`★ ${ids} ${what} — 매니지드면 말하고, 셀프호스트면 아무것도 안 그린다`, () => {
    const f = loadFn(fn);
    const managed = f(true);
    assert.notEqual(managed.trim(), "",
      `${ids} 매니지드인데 ${fn}() 이 빈 문자열이다 — #2476 의 결정(자격을 옮기는 대신 말해 준다)이 화면에서 사라졌다. ` +
      `새 워크스페이스에 들어간 사람은 다시 «방금 로그인했는데 왜 또?» 를 겪는다.`);
    assert.equal(f(false), "",
      `${ids} 셀프호스트인데 ${fn}() 이 문장을 낸다 — 거기선 이 말이 **거짓**이다(멤버 홈이 사람 축 하나라 ` +
      `자격이 애초에 안 사라진다). 없는 불편을 있다고 말하면 사람이 쓸데없이 다시 로그인한다.`);
  });
}

// ── E5 — «따로다» 만 말하지 않는다 ──────────────────────────────────────────
test("★ E5 안내는 «한 번만/계속» 을 함께 말한다 — 겁주기가 아니라 놀람 제거가 목적이다", () => {
  //  문구를 고정하지 않는다. «한 번» 또는 «계속» 중 하나라도 있으면 «매번 물을 것» 이라는 오독을 막는다.
  for (const [fn, what] of CASES) {
    const s = loadFn(fn)(true);
    assert.match(s, /한 번|계속/,
      `${what} 의 안내가 «따로다» 만 말한다 — 사람은 «여기서도 매번 묻겠구나» 로 읽는다. ` +
      `이 워크스페이스에서는 한 번이면 끝난다는 것을 함께 말해야 놀람이 가신다.`);
  }
});

// ── E6/E7 — 두 화면이 이 자리를 실제로 지나고, 매니지드 여부를 넘긴다 ────────
//  «관측 장치가 죽어 있으면 시험은 통과하면서 아무것도 안 본다» — 위 E1~E5 는 판정 함수만 재므로,
//  화면이 그 함수를 안 쓰거나 상수를 넘기면 위 넷은 전부 초록인 채로 사람은 그대로 겪는다.
const WIRING: Array<[string, string, string]> = [
  ["web/v2/rail.ts", "aiLoginScopeHint", "만들기 패널"],
  ["web/v2/onboarding.ts", "aiLoginScopeNote", "온보딩 «AI 연결» 로그인 화면"],
];

for (const [rel, fn, what] of WIRING) {
  test(`★ E6/E7 ${what}(${rel}) — 판정 자리를 지나고, 매니지드 여부를 넘긴다`, () => {
    const src = readSrc(rel);
    assert.match(src, new RegExp(`import[^\\n]*\\b${fn}\\b[^\\n]*ai-login-scope\\.js`),
      `E6 ${rel} 이 ${fn} 을 ai-login-scope.js 에서 가져오지 않는다 — 문구를 화면에 직접 박았다면 ` +
      `다른 화면과 어긋나고(만들 땐 말해 놓고 들어가선 안 말하는 상태) 셀프호스트 게이트도 함께 샌다.`);
    assert.match(src, new RegExp(`${fn}\\(managedWorkspaces\\(\\)\\)`),
      `E7 ${rel} 이 ${fn}(managedWorkspaces()) 로 부르지 않는다 — 매니지드 여부를 안 넘기면 ` +
      `셀프호스트에도 안내가 서거나(거짓말) 매니지드에서 안 선다(놀람 그대로).`);
  });
}

// ── E6 보강 — 문구가 화면에 사본으로 남지 않았나 ────────────────────────────
test("★ E6 안내 문구는 ai-login-scope 밖에 사본이 없다 — 두 벌이 되면 조용히 어긋난다", () => {
  //  표지 한 조각만 본다(전문 고정 금지). 문구를 다시 쓸 땐 이 표지도 함께 고쳐라 — 그게 이 단언을
  //  의도적으로 지나가는 유일한 길이다(표지를 바꾸고 두면 아래는 0건으로 조용히 통과한다).
  const MARK = "워크스페이스마다 따로";
  assert.ok(stripComments(SCOPE).includes(MARK),
    `${SCOPE_SRC} 의 **코드**에 표지 «${MARK}» 가 없다 — 문구를 다시 썼다면 이 시험의 MARK 도 고쳐라`);
  for (const [rel] of WIRING) {
    //  주석은 걷고 본다 — 화면 파일은 «왜 여기서 이 말을 하나» 를 주석으로 설명하고, 그건 사본이 아니다.
    assert.ok(!stripComments(readSrc(rel)).includes(MARK),
      `${rel} 의 코드에 안내 문구 사본이 있다 — 문구가 두 벌이 되면 한쪽만 고쳐져 두 화면이 다른 말을 한다`);
  }
});
