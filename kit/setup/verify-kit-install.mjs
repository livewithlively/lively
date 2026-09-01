#!/usr/bin/env node
// 설치된 훅 런타임이 **실제로 실행 가능한지** 검사한다 — 정적 검사라 훅을 실행하지 않는다.
//
// 왜 이게 따로 필요한가 — 2026-08-27 사고에서 배포는 성공했고 멤버 홈의 파일 개수는 오히려 늘었는데
//  훅은 전멸이었다. 기존 배포 테스트는 「리프레시가 호출되는가(bluegreen-logic.test.mjs) · 백필이 kit
//  게이트 앞인가(member-codex-install.test.mjs)」 라는 **배선**만 잠갔고, 「심어 놓은 트리가 import 를
//  풀 수 있는가」는 아무도 보지 않았다. 훅은 non-blocking 이라 실패해도 세션이 뜨므로, 이 축을 자동으로
//  보지 않으면 다음 사고도 똑같이 **사용자 제보로만** 발견된다.
//
// 판정 규칙
//  · 정적 `import/export … from "./x"` 와 `import "./x"` 는 **전부** 풀려야 한다.
//  · 동적 `import("./x")` 는 **파일 단위 any-of** — 한 파일 안의 동적 import 중 최소 하나만 풀리면 통과.
//    host-effects-port.mjs 가 소스트리(`../setup/`)와 설치트리(`../lib/`)를 try/catch 로 번갈아 시도하는
//    포트 패턴이고, 설치 자리에선 앞쪽이 없는 게 **정상**이다. 둘 다 없으면(=이번 사고) 잡힌다.
//  · 매니페스트가 놓기로 한 파일(HOOK_SCRIPTS·LIB_FILES)이 실제로 있는지도 함께 본다.
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { HOOK_SCRIPTS, LIB_FILES, isDirectRun } from "./kit-manifest.mjs";

// 주석 줄을 걷어낸다 — 설명 주석의 import 예시를 실제 의존으로 오인하지 않기 위해. 레포의 다른
//  스크립트 검사(provision-member-order.test.mjs 등)와 같은 관례다.
//  ⚠ 정규식으로 블록주석을 먼저 지우면 안 된다: 이 레포의 주석엔 `~/.lively/hooks/*.mjs` 처럼 `/*` 를
//   품은 경로가 흔해서, `/\*[\s\S]*?\*\/` 가 거기서부터 파일 절반을 삼킨다(실측: user-install.mjs 가
//   72KB→37KB 로 줄며 import 블록이 통째로 사라져 정적 의존이 0건으로 나왔다). 줄 단위가 안전하다.
const codeOnly = (src) => src
  .split(/\r?\n/)
  .filter((l) => { const t = l.trimStart(); return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*"); })
  .join("\n");

// import/export 문은 `;` 로 끝난다 — `[^;]` 로 경계를 잡으면 여러 줄에 걸친 형태도 잡으면서 다음 문으로
//  새지 않는다.
const FROM_RE = /(?:^|\n)[ \t]*(?:import|export)\b[^;]*?\bfrom\s*["'](\.[^"']*)["']/g;
const BARE_RE = /(?:^|\n)[ \t]*import\s*["'](\.[^"']*)["']/g;        // import "./x" (부작용 전용)
const DYN_RE = /\bimport\s*\(\s*["'](\.[^"']*)["']\s*\)/g;

const matches = (src, re) => [...src.matchAll(re)].map((m) => m[1]);

/**
 * 소스에서 **상대** import 지정자를 뽑는다(주석 제외). 정적/동적을 갈라 돌려주는 이유는 판정이 다르기
 *  때문이다 — 정적은 전부, 동적은 파일 단위 any-of. kit-manifest.test.mjs 도 이걸 재사용해
 *  「설치기가 import 하는 setup/ 모듈이 번들 목록에 다 있는가」를 본다(사본을 만들지 않는다).
 * @param {string} source
 * @returns {{statics: string[], dynamics: string[]}}
 */
export function relativeImports(source) {
  const src = codeOnly(source);
  return { statics: [...matches(src, FROM_RE), ...matches(src, BARE_RE)], dynamics: matches(src, DYN_RE) };
}

// ESM 은 확장자를 요구하지만, 혹시 생략돼 있으면 관례 확장자까지 시도해 본다(있으면 통과로 친다).
function resolveSpec(fromFile, spec) {
  const base = resolve(dirname(fromFile), spec);
  for (const cand of [base, `${base}.mjs`, `${base}.js`]) {
    try { if (statSync(cand).isFile()) return cand; } catch { /* 다음 후보 */ }
  }
  return null;
}

/**
 * @param {string} livelyDir 멤버 홈의 ~/.lively 절대경로
 * @returns {{ok: boolean, problems: string[]}}
 */
export function verifyKitInstall(livelyDir) {
  const root = resolve(livelyDir);
  const problems = [];

  // ① 매니페스트가 놓기로 한 것이 실제로 있는가 — 아무도 import 하지 않아도 누락은 누락이다.
  for (const f of HOOK_SCRIPTS) {
    if (!existsSync(join(root, "hooks", f))) problems.push(`훅 파일 누락: hooks/${f}`);
  }
  for (const f of LIB_FILES) {
    if (!existsSync(join(root, f.dest))) problems.push(`공유 모듈 누락: ${f.dest}`);
  }

  // ② import 폐포 — 설치 트리 안에서 실제로 풀리는가(전이 포함).
  const seen = new Set();
  const queue = HOOK_SCRIPTS.map((f) => join(root, "hooks", f)).filter((p) => existsSync(p));
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);

    let src;
    try { src = readFileSync(file, "utf8"); } catch { continue; }
    const rel = file.startsWith(root) ? file.slice(root.length + 1) : file;

    const { statics, dynamics: dyn } = relativeImports(src);
    for (const spec of statics) {
      const target = resolveSpec(file, spec);
      if (!target) problems.push(`${rel} → ${spec} 를 풀 수 없음(정적 import)`);
      else if (target.startsWith(root)) queue.push(target);
    }

    // 동적 import 는 대체 경로(포트 패턴)일 수 있어 파일 단위 any-of 로 본다.
    if (dyn.length) {
      const resolved = dyn.map((s) => resolveSpec(file, s)).filter(Boolean);
      if (!resolved.length) {
        problems.push(`${rel} → 동적 import 후보가 하나도 풀리지 않음: ${dyn.join(" | ")}`);
      }
      for (const t of resolved) if (t.startsWith(root)) queue.push(t);
    }
  }

  return { ok: problems.length === 0, problems };
}

// ── CLI: `node kit/setup/verify-kit-install.mjs <~/.lively 경로>` → 실패 시 exit 1 ──
//  ⚠ 진입 판정은 isDirectRun(kit-manifest) 이 한다 — 손으로 argv[1] 을 비교하면 심링크 경로에서
//   이 블록이 통째로 안 돌아 **검증이 무음으로 건너뛰어지고 exit 0** 이 된다. 부르는 쪽
//   (refresh-member-kits.sh 의 `if vout="$(node "$VERIFY" …)"`)은 그걸 «설치 검증 통과» 로 읽는다 —
//   2026-08-27 «멤버 훅 전멸» 을 잡으라고 만든 안전망이 그 자체로 무음이 되는 자리였다.
if (isDirectRun(import.meta.url)) {
  const target = process.argv[2];
  if (!target) { console.error("사용: node kit/setup/verify-kit-install.mjs <lively-dir>"); process.exit(2); }
  const { ok, problems } = verifyKitInstall(target);
  if (ok) { console.log(`✓ 훅 런타임 설치 검증 통과 — ${target}`); process.exit(0); }
  for (const p of problems) console.error(`✗ ${p}`);
  process.exit(1);
}
