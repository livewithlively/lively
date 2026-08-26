// #1891 + #1842 — "한 사건에 배너는 한 장".
//
// 알림을 띄우는 표면이 둘이 됐다: 데스크톱 앱(#1842, 트레이에서 SSE 구독 — 창을 닫아도 뜬다)과
//  웹 셸(#1891, 탭이 열려 있을 때). 둘 다 같은 `awaiting` 사건을 본다. 그대로 두면 데스크톱 앱
//  안에서 웹 UI 가 돌 때 **한 사건에 배너가 두 장** 뜬다.
//
// ⚠ 왜 소스 텍스트를 보나: 이건 값이 아니라 **배선**의 성질이다. 런타임에서 재현하려면 Electron 을
//  띄우고 SSE 를 물려야 하는데, 그러고도 "두 장 떴다"를 자동으로 세기 어렵다. 반면 규칙 자체는
//  단순하다 — 다리(livelyDesktop)가 있으면 웹은 물러난다. 그 양보가 사라지는 것을 여기서 잡는다.
//  (같은 규율: scripts/pane-session-scope.test.mjs · scripts/shell-surface-registry.test.mjs)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
let pass = 0;
const ok = (cond, name, detail) => { assert.ok(cond, detail ? `${name}\n${detail}` : name); pass++; console.log(`ok  ${name}`); };

const NOTI = read("web/v2/notifications.ts");
const VIEWS = read("web/v2/views.ts");
const MAIN = read("web/v2/main.ts");

function slice(src, from, to) {
  const a = src.indexOf(from);
  assert.ok(a >= 0, `구간 시작을 못 찾았다: ${from}`);
  const b = src.indexOf(to, a + 1);
  assert.ok(b > a, `구간 끝을 못 찾았다: ${to}`);
  return src.slice(a, b);
}

// ── 1. 배너를 만드는 함수는 데스크톱이면 즉시 물러난다 ──────────────────────
const raise = slice(NOTI, "export function raiseBanners", "\n}");
ok(/livelyDesktop\)\s*return 0;/.test(raise), "raiseBanners 는 데스크톱 앱 안이면 배너를 만들지 않는다",
  "  → 그 앱(#1842)이 트레이에서 같은 사건을 이미 띄운다. 이 양보가 없으면 배너가 두 장이다.\n"
  + "  → 능력 감지는 **다리의 유무**로만 한다(플랫폼·UA 추측 금지 — 구 앱·새 웹 조합에서 어긋난다).");

// ── 2. 폴링 루프도 데스크톱이면 아예 안 돈다(서버를 부를 이유가 없다) ─────────
const start = slice(NOTI, "export function startNotificationBanners", "\n}");
ok(/livelyDesktop\)\s*return;/.test(start), "배너 폴링은 데스크톱 앱 안에서 시작조차 하지 않는다",
  "  → 배너를 안 띄울 거면 30초마다 알림을 받아올 이유도 없다.");

// ── 3. ★배너는 화면과 무관하게 돈다 — 「확인할 것」 안에서만 띄우면 보고 있어야 알림이 뜬다 ──
// ⚠ 줄 맨 앞의 **실제 호출**만 인정한다 — 느슨하게 이름만 찾으면 주석 처리해도 통과한다(fail-first 로 잡았다).
ok(/^\s*startNotificationBanners\(\);/m.test(MAIN), "셸 부팅이 배너 폴링을 켠다",
  "  → 2026-08-25 상민님 신고('왜 알림 안 오냐')의 원인이 정확히 이것이었다:\n"
  + "     raiseBanners 가 inbox 렌더 안에서만 불려, 그 화면을 열어야 배너가 떴다(알림의 목적과 정반대).");

// ── 4. inbox 화면은 배너를 **또** 띄우지 않는다 ─────────────────────────────
ok(!/raiseBanners/.test(VIEWS), "「확인할 것」 화면은 배너를 띄우지 않는다(이력만 그린다)",
  "  → 셸이 이미 전역으로 띄운다. 여기서 또 부르면 이 화면을 열 때마다 두 번 뜬다.");

console.log(`\nnotification-banner-scope: ${pass} passed`);
