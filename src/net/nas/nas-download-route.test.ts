// NAS 내려받기 Content-Disposition 사양 검증 — 늘 attachment, ASCII 대체 filename 과 RFC 5987 filename* 병기.
// 실행: npm run build && node dist/net/nas/nas-download-route.test.js
import assert from "node:assert/strict";
import { contentDisposition } from "./nas-download-route.js";

let pass = 0;
const failed: string[] = [];
const t = (name: string, fn: () => Promise<void> | void): Promise<void> =>
  Promise.resolve().then(fn).then(
    () => { pass++; console.log(`ok  ${name}`); },
    (e) => { failed.push(name); console.log(`FAIL ${name}\n     ${String(e?.message ?? e).split("\n").join("\n     ")}`); },
  );

await t("contentDisposition: 마지막 마디를 파일명으로, ASCII 대체 이름과 UTF-8 퍼센트 인코딩 둘 다", () => {
  const cases: [string, string, string][] = [
    ["/a/b/report.pdf", "report.pdf", "report.pdf"],
    ["/문서/보고서 2024.hwp", "___ 2024.hwp", encodeURIComponent("보고서 2024.hwp")],
    ['/x/a"b\\c.txt', "a_b_c.txt", encodeURIComponent('a"b\\c.txt')],
    ["/x/약정서(1)'s*!.pdf", "___(1)'s*!.pdf", encodeURIComponent("약정서(1)'s*!.pdf")],
  ];
  for (const [path, ascii, pct] of cases) {
    const v = contentDisposition(path);
    assert.match(v, /^attachment\s*;/, path);
    assert.ok(v.includes(`filename="${ascii}"`), `${path} → ${v}`);
    const star = /filename\*=UTF-8''([^;\s]+)/.exec(v);
    assert.ok(star, `${path} → ${v}`);
    assert.equal(decodeURIComponent(star![1]), decodeURIComponent(pct), path);
    assert.match(star![1], /^[A-Za-z0-9%._~-]+$/, "RFC 5987 attr-char 밖 문자 없음");
  }
});

console.log(`\n${pass} passed, ${failed.length} failed`);
if (failed.length) process.exitCode = 1;
