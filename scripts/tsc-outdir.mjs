// tsc 증분 빌드의 **산출 디렉터리 정합** — 순수 판정만. 파일시스템·tsc 는 호출자(build-web.mjs)가 쥔다.
//
//  ── 왜 있나 (#1830) ──
//  tsc 는 증분 빌드에서 두 가지를 하지 않는다:
//   ① **사라진 소스의 산출물을 지우지 않는다** → 브랜치를 옮기거나 모듈을 지워도 옛 `.js` 가 outDir 에 남고,
//      build-web.mjs 가 그 디렉터리를 통째로 public/app 으로 옮기므로 **유령 모듈이 서빙된다**. git 에는
//      untracked(`??`)로 떠서 `git add -A` 한 번에 남의 브랜치 산출물이 커밋되고, 릴리스 게이트
//      (`git diff --exit-code -- public/app`)는 tracked 만 보므로 이 유령을 못 잡는다.
//   ② **증분 기록(.tsbuildinfo)과 실제 산출물이 어긋나도 모른다** → 기록이 "다 했다"고 하면 emit 을 건너뛴다.
//      outDir 을 손으로 지우면 그 다음 빌드가 아무것도 만들지 않고 죽는다(2026-08-20 실측). 산출물이
//      **일부만** 사라진 경우도 같다 — dist 가 반쪽이 된 채 하위 단계(esbuild)가 죽었다(2026-08-14 실측,
//      [[stale-tsbuildinfo-partial-dist-esbuild-fail]]). 두 사고 모두 "손으로 지우세요" 런북으로 남아 있었다.
//
//  ── 안전 방향 ──
//  지우는 판정은 **모양을 아는 것에만** 내린다. tsc 산출물 모양이 아닌 파일은 무엇이든 남긴다(남기는 쪽이
//  안전하다 — 잘못 지우면 빌드가 깨지고, 잘못 남기면 다음 빌드가 다시 지운다).
//  ⚠ prune 은 **outDir 을 그 프로젝트가 독점할 때만** 쓸 수 있다. 예: `dist` 는 src tsc·standalone tsc·
//   esbuild 가 함께 쓰므로 prune 하면 남의 산출물을 지운다. `build/web-app` 은 web tsc 전용이라 안전하다.

/**
 * tsc 가 소스 하나에서 낼 수 있는 산출물 꼬리들.
 * ⚠ **이 목록에 `.ts` 를 넣지 마라.** 넣는 순간 `a.d.ts` 가 `.ts` 에 먼저 걸려 `a.d` 의 산출물로 읽히고,
 *  소스(`a.ts`)가 멀쩡한 파일이 고아로 판정돼 **지워진다**(scripts/tsc-outdir.test.mjs 2행이 이걸 막는다).
 *  지금 네 꼬리는 서로 접미사로 겹치지 않아 **순서는 결과에 영향이 없다** — 겹치는 꼬리를 더할 땐 긴 것을 앞에.
 */
const OUT_SUFFIXES = ['.d.ts.map', '.d.ts', '.js.map', '.js'];
/** 그 산출물을 냈을 수 있는 소스 확장자들. */
const SRC_EXTS = ['.ts', '.tsx', '.mts', '.cts'];

/**
 * 산출 파일(outDir 상대경로) → 그것을 만들어 냈을 **소스 상대경로 후보**.
 * 우리가 아는 tsc 산출물 모양이 아니면 null — 호출자는 그런 파일에 손대지 않는다.
 */
export function sourcesForOutput(rel) {
  for (const suf of OUT_SUFFIXES) {
    if (rel.endsWith(suf) && rel.length > suf.length) {
      const base = rel.slice(0, -suf.length);
      return SRC_EXTS.map((e) => base + e);
    }
  }
  return null;
}

/**
 * outDir 에 남은 것 중 **소스가 사라진 것**만 고른다(고아).
 * @param outRels  outDir 상대경로 목록(posix 구분자)
 * @param srcRels  rootDir 상대경로 소스 목록(posix 구분자) — 선언파일(.d.ts)은 호출자가 뺀다
 */
export function planOrphans(outRels, srcRels) {
  const src = new Set(srcRels);
  const orphans = [];
  for (const rel of outRels) {
    const cands = sourcesForOutput(rel);
    if (!cands) continue;                                  // 모르는 모양은 남긴다
    if (!cands.some((c) => src.has(c))) orphans.push(rel);
  }
  return orphans;
}

/**
 * 증분 기록이 "다 했다"고 하는데 **실제로 없는** 산출물 목록.
 * 하나라도 있으면 그 기록은 거짓이므로 호출자는 .tsbuildinfo 를 버리고 전량 재생성해야 한다.
 */
export function missingOutputs(srcRels, outRels) {
  const out = new Set(outRels);
  const missing = [];
  for (const s of srcRels) {
    const base = stripSourceExt(s);
    if (base === null) continue;                           // 소스 확장자가 아니면 판정 대상이 아니다
    if (!out.has(base + '.js')) missing.push(s);
  }
  return missing;
}

/** 소스 상대경로에서 확장자를 뗀다. 소스 확장자가 아니면 null. */
export function stripSourceExt(rel) {
  for (const e of SRC_EXTS) if (rel.endsWith(e) && rel.length > e.length) return rel.slice(0, -e.length);
  return null;
}

/** 선언 파일은 산출물을 내지 않으므로 완전성 판정에서 뺀다. */
export const isDeclaration = (rel) => rel.endsWith('.d.ts');
