// #3568 — [AI 세션] 구역의 세션 행에 ×(보관)가 서 있는가.
//
// 무엇이 문제였나 (상민님 2026-09-05): "사이드바에 세션 하나 호버하면 x가 안 뜬다 … 너무 혼잡스러워 못 닫아서".
//  코드에 매니지드/셀프호스팅 분기는 없다 — 갈린 것은 **구역**이었다. 홈과 프로젝트 트리에는 × 가 있고,
//  [AI 세션] 구역만 #2033 에서 «압정·× 안 그림»으로 묶여 나갔다. 그 근거(«치우면 찾을 곳이 없어진다»)는
//  홈의 ×(열린 목록에서 치우기)의 것이지, 여기 × 의 뜻(보관 = [지난 세션] 으로 옮김)에는 성립하지 않는다.
//  세션이 몇백 줄로 쌓이는 자리가 정확히 이 명부라, 여기서 못 접으면 사람은 접을 길이 없다.
//
// 이 파일이 지키는 것 넷 — 다시 «목록의 성질»만 보고 × 를 통째로 끄는 일이 없도록:
//  ① [AI 세션] 목록이 × 를 켠다            ② 행이 자기 뜻(보관·휴지통)을 들고 온다
//  ③ 남의 세션엔 안 그린다(서버가 소유자만 허용) ④ 터치 기기에서 × 에 닿을 길이 있다(display, opacity 아님)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const ok = (cond, name) => { assert.ok(cond, name); console.log(`ok  ${name}`); };

const SIDE = read("web/v2/side.ts");
const CSS = read("public/styles/40-v2.css");

// ── ① [AI 세션] 구역(renderSessions)의 행 옵션 — 압정은 끄고 × 는 켠다 ──────────
const rowOpts = /const rowOpts: RowOpts = \{([^}]*)\}/.exec(SIDE);
ok(!!rowOpts, "① renderSessions 의 rowOpts 를 찾는다");
ok(/close:\s*true/.test(rowOpts[1]),
  "① ★[AI 세션] 목록이 × 를 켠다 — 끄면 몇백 줄 명부에서 한 줄도 못 접는다(#3568)");
ok(/pin:\s*false/.test(rowOpts[1]),
  "① 압정은 그대로 끈다 — 순서의 정본은 상태(bySeen)라 고정이 그 순서를 흔든다(#2033)");

// ── ② 행이 × 의 뜻을 들고 온다 — 도는 세션은 보관, 지난 세션은 휴지통 ──────────
const inst = SIDE.slice(SIDE.indexOf("function sessAsInst"), SIDE.indexOf("function renderSessions"));
ok(/close:\s*!isMine\(s\)\s*\?\s*null/.test(inst),
  "③ ★남의 세션엔 × 를 안 그린다(null) — 서버도 소유자만 허용한다");
ok(/doArchive\(s\)/.test(inst), "② 도는 세션의 × 는 보관(지난 세션으로) — doArchive");
ok(/doTrash\(s\)/.test(inst), "② 지난 세션의 × 는 휴지통 — doTrash");

// ── ②' 공용 붓이 그 뜻을 실제로 쓴다(안 쓰면 위 셋이 장식이 된다) ───────────────
ok(/const canClose = o\.close !== false && act !== null;/.test(SIDE),
  "②' appRowEl: 목록이 켜고(o.close) 행이 끈다(act === null)");
ok(/if \(act\) act\.run\(\); else hooks\.onCloseInstance/.test(SIDE),
  "②' appRowEl: 행이 뜻을 들고 오면 그것을, 없으면 홈의 뜻을 실행한다");

// ── ④ 터치 기기 — 이 × 는 opacity 가 아니라 display 로 숨는다 ──────────────────
//  ⚠ 이 파일엔 `@media (hover: none)` 블록이 여럿이고 안에 중첩 규칙이 있다 — 정규식이 아니라
//   **중괄호를 세어** 블록을 떼어 낸다(정규식은 첫 `}` 에서 잘려 늘 빈손으로 통과한다).
function mediaBlocks(css, at) {
  const out = [];
  for (let i = css.indexOf(at); i >= 0; i = css.indexOf(at, i + 1)) {
    let depth = 0, start = -1;
    for (let j = css.indexOf("{", i); j < css.length; j++) {
      if (css[j] === "{") { if (depth++ === 0) start = j + 1; }
      else if (css[j] === "}" && --depth === 0) { out.push(css.slice(start, j)); break; }
    }
  }
  return out;
}
const hoverNone = mediaBlocks(CSS, "@media (hover: none)");
ok(hoverNone.length > 0, "④ @media (hover: none) 블록을 찾는다");
ok(hoverNone.some((b) => /\.v2-app-inst-close \{[^}]*display:\s*inline-grid/.test(b)),
  "④ ★터치 기기에서 × 가 실제로 뜬다 — opacity:1 은 display:none 을 못 이겨 아무 일도 안 했다(#3568)");

console.log("\n#3568 [AI 세션] 세션 행 × — 통과");
