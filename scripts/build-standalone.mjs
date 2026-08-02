#!/usr/bin/env node
// 단독 페이지 번들(#1313 R51) — web/standalone/*.ts → public/*.js (경로 불변: HTML 이 종전 그대로 로드).
//  scripts/build-node-agent.mjs 와 동형(esbuild 로 한 파일 산출). 차이는 대상이 브라우저·클래식 스크립트라는 것:
//   format=iife → 최상위 선언이 전역을 오염시키지 않고, <script src> 로 그대로 실행된다(module 아님 — defer 유지).
//  ⚠ treeShaking=false: 이 소스들은 손편집 JS 를 verbatim 이관한 것이라 '도달 불가로 보이지만 실제로 쓰이는' 코드가
//   있을 위험이 있다(전역 노출·이벤트 배선). 동작 동일성이 최우선이라 제거 최적화를 끈다.
//  TERMJS_BUILD: 종전엔 소스 상수를 손으로 고치고 terminal.html 의 ?v= 도 손으로 맞췄다(둘이 어긋나면 진단이 거짓말).
//   이제 소스 콘텐츠 해시를 빌드 시 주입한다 — 사람이 갱신할 것이 없다.
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync, statSync } from "node:fs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => join(root, "web", "standalone", p);
const out = (p) => join(root, "public", p);

// 빌드 스탬프 = 단독 페이지 소스 전체의 콘텐츠 해시(앞 8자). 내용이 같으면 값도 같다(재빌드로 무의미하게 안 바뀜).
const STAMP_INPUTS = ["terminal.ts", "terminal.entry.ts", "md.ts", "md.entry.ts", "page-scrollbar.ts"];
const stamp = (() => {
  const h = createHash("sha256");
  for (const f of STAMP_INPUTS) h.update(f).update("\0").update(readFileSync(src(f)));
  return h.digest("hex").slice(0, 8);
})();

// strict: 종전 손편집 원본이 최상위에 'use strict' 를 두었던 파일만 그대로 재현한다(iife 래핑으로 지시어가
//  소거되면 산출물은 sloppy mode 가 된다 — this 바인딩·묵시적 전역 등 미세한 의미 차이가 생기는 자리).
const targets = [
  { entry: "terminal.entry.ts", outfile: "terminal.js", strict: true },
  { entry: "md.entry.ts", outfile: "md.js", strict: true },
  { entry: "page-scrollbar.ts", outfile: "page-scrollbar.js", strict: false },
];

for (const t of targets) {
  await build({
    entryPoints: [src(t.entry)],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: ["es2022"],
    outfile: out(t.outfile),
    treeShaking: false,
    define: { TERMJS_BUILD: JSON.stringify(stamp) },
    banner: t.strict ? { js: "'use strict';" } : undefined,
    logLevel: "info",
  });
  const kb = (statSync(out(t.outfile)).size / 1024).toFixed(0);
  console.log(`✓ 단독 페이지 번들: public/${t.outfile} (${kb} KiB)`);
}
console.log(`✓ 빌드 스탬프 TERMJS_BUILD=${stamp} (소스 콘텐츠 해시 — 수동 갱신 불요)`);
