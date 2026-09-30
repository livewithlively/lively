// #4225 — 빌트인 앱 화면은 **폼 제출에 기대지 않는다.**
//
//  앱 화면은 `sandbox="allow-scripts"` iframe 이다(web/v2/app-ui.ts — 부모 토큰·스토리지 격리). 이 샌드박스에선 브라우저가
//   폼 제출을 **submit 이벤트를 쏘기 전에** 막는다 — onsubmit 에서 preventDefault 하는 흔한 모양도 핸들러가 아예 안 불린다.
//   실측(2026-09-29 매니지드): 「안녕 앱」 0.2 의 [남기기]·Enter 가 아무 반응이 없었고, 콘솔엔
//   «Blocked form submission to '' because the form's frame is sandboxed and the 'allow-forms' permission is not set.»
//  그래서 버튼 click · 입력칸 keydown 으로 받는다. 이 테스트는 그 규칙을 빌트인 앱 전부에 건다(새 빌트인도 자동 대상).
//  ⚠ 호스트 샌드박스(allow-scripts 뿐)가 바뀌지 않았는지도 함께 본다 — 그게 바뀌면 이 규칙의 전제가 바뀐 것이다.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0;
const ok = (cond, name, detail = "") => { assert.ok(cond, detail ? `${name}\n${detail}` : name); pass++; console.log(`ok  ${name}`); };

// 호스트가 앱 화면에 거는 샌드박스 — 이 규칙의 전제.
const HOST = readFileSync(join(root, "web/v2/app-ui.ts"), "utf8");
ok(/sandbox:\s*'allow-scripts',/.test(HOST), "앱 화면 샌드박스는 allow-scripts 뿐(allow-forms 없음) — 폼 제출이 막히는 전제",
  "  → 호스트가 allow-forms 를 주게 바뀌었다면 이 테스트의 규칙을 다시 판단하라.");

// 빌트인 앱의 화면 HTML 전부.
const APPS = join(root, "apps/builtin");
const pages = [];
for (const id of readdirSync(APPS)) {
  const mf = join(APPS, id, "lively-app.json");
  if (!existsSync(mf)) continue;
  const m = JSON.parse(readFileSync(mf, "utf8"));
  for (const p of (m.ui && m.ui.pages) || []) {
    const f = join(APPS, id, p.entry);
    if (existsSync(f) && statSync(f).isFile()) pages.push({ id, file: f, html: readFileSync(f, "utf8") });
  }
}
ok(pages.length > 0, `빌트인 앱 화면 ${pages.length}개를 실제로 읽었다(배선 — 0이면 아래가 vacuous)`);
for (const p of pages) {
  const forms = (p.html.match(/<form[\s>]/gi) || []).length;
  ok(forms === 0, `${p.id}: 폼(form 태그) 없음 — 샌드박스에선 제출이 submit 이벤트 전에 막힌다`,
    `  → ${p.file} 에 form 태그 ${forms}개. 버튼 click · 입력칸 keydown(Enter, 한글 조합 중 제외)으로 받아라.`);
}
console.log(`\n${pass} passed`);
