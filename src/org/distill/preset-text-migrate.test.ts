// #4824 — 프리셋 레인 문구 이관의 짝이 지금 프리셋 문구와 맞는가(순수). DB 로 바꾸는 장면은 derived-visibility.pg-test(T1).
import assert from "node:assert/strict";
import { PRESET_TEXT_MIGRATIONS } from "./preset-text-migrate.js";
import { LOCAL_CRITERIA_MD, LOCAL_FORMAT_MD } from "./local-preset.js";
import { GITHUB_CRITERIA_MD, GITHUB_FORMAT_MD } from "./github-preset.js";
import { FIGMA_CRITERIA_MD, FIGMA_FORMAT_MD } from "./figma-preset.js";
import { ZOTERO_CRITERIA_MD, ZOTERO_FORMAT_MD } from "./zotero-preset.js";

const PRESETS = { LOCAL_CRITERIA_MD, LOCAL_FORMAT_MD, GITHUB_CRITERIA_MD, GITHUB_FORMAT_MD, FIGMA_CRITERIA_MD, FIGMA_FORMAT_MD, ZOTERO_CRITERIA_MD, ZOTERO_FORMAT_MD };
let n = 0;
const t = (name: string, fn: () => void): void => { fn(); n++; console.log(`ok  ${name}`); };

t("M1 짝의 to 는 지금 프리셋 문구 어딘가에 그대로 있다(이관이 지금 코드와 같은 문구로 간다)", () => {
  for (const m of PRESET_TEXT_MIGRATIONS) {
    assert.ok(Object.values(PRESETS).some((p) => p.includes(m.to)), `to 가 어느 프리셋에도 없다: ${m.why}`);
  }
});
t("M2 짝의 from 은 지금 프리셋 문구에 없다(옛 문구를 다시 되살리지 않는다)", () => {
  for (const m of PRESET_TEXT_MIGRATIONS) {
    for (const [k, p] of Object.entries(PRESETS)) assert.ok(!p.includes(m.from), `${k} 에 옛 문구가 남아 있다: ${m.why}`);
  }
});
t("M3 옛 프리셋(지금 문구에 to → from 을 되돌린 것)에 이관을 걸면 지금 프리셋과 글자 그대로 같다 · 두 번 걸어도 같다", () => {
  for (const [k, cur] of Object.entries(PRESETS)) {
    let old = cur;
    for (const m of PRESET_TEXT_MIGRATIONS) old = old.split(m.to).join(m.from);
    let once = old;
    for (const m of PRESET_TEXT_MIGRATIONS) once = once.split(m.from).join(m.to);
    let twice = once;
    for (const m of PRESET_TEXT_MIGRATIONS) twice = twice.split(m.from).join(m.to);
    assert.equal(once, cur, k);
    assert.equal(twice, cur, k);
  }
});
console.log(`preset-text-migrate: ${n} passed`);
