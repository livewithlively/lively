// 자산 세대(빌드버전) — 「지금 서빙되는 웹 자산이 어느 판인가」를 12자로 답하는 계산의 **정본**.
//
// ── 왜 web.ts 밖으로 나왔나 (#2643) ────────────────────────────────────────
// 부르는 자리가 둘이 됐다:
//  ① **서빙**(web.ts) — 이 값으로 `?v=` 를 박아 캐시를 가른다(#1017). 런타임 계산이다.
//  ② **굽기**(scripts/stamp-assets.mjs) — 같은 값을 이미지에 남긴다. 그래야 매니지드 롤이
//     「사람이 받는 자산에 이번 판이 닿았나」를 물을 수 있다. 롤이 전 축 초록인데 기존 테넌트가
//     옛 화면을 서빙한 실측이 계기다(지식 core-web-change-not-reaching-existing-tenants-1631).
//
// ★ 계산을 두 벌 두면 규칙이 갈리는 날 롤이 **거짓 드리프트**를 낸다. 그리고 이 규칙은 실제로
//  두 번 바뀌었다 — #1313 R50 이 styles/ 를 더했고 R28 이 app/ 을 재귀로 바꿨다. 한쪽만 따라가면
//  「자산은 닿았는데 롤이 빨간불」이 되고, 그러면 다음 사람이 축을 끈다. 그래서 한 벌이다.
//
// ⚠ 이 파일은 **파일시스템만** 읽는다(express·설정 무관). 굽기 스크립트가 dist 에서 곧장 부른다.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

/** 굽기가 자산 세대를 남기는 자리(public 하위). 롤 검증이 이미지 안에서 이 파일을 되읽는다.
 *  ★ 이름이 `.` 으로 시작하고 확장자가 js/mjs/css 가 아니라 **자기 자신은 목록에 안 들어간다** —
 *   들어가면 파일을 쓸 때마다 값이 바뀌어 영영 수렴하지 않는다(자기참조). 시험이 이걸 못 박는다. */
export const ASSET_VERSION_FILE = ".asset-version";

/** 자산 세대 스탬프의 내용. `v` 는 아래 computeAssetVersion 과 **같은 값**이어야 한다. */
export type AssetStamp = { v: string; files: number };

/**
 * 빌드버전 입력이 되는 로컬 자산 목록(publicDir 기준 상대경로, 정렬).
 *
 * 로컬 자산 = public 최상위 *.{js,mjs,css} + public/app/**(하위 포함) *.{js,mjs} + public/styles/**\/*.css.
 *  (fonts/img 는 자체로 거의 불변이라 제외 — 필요 시 확장.)
 *  #1313 R50 — 옛 단일 styles.css 를 화면별 public/styles/*.css 로 분할했다. 이 목록이 곧
 *  ① 빌드버전(콘텐츠 해시) 입력 ② ?v= immutable 스탬프 대상이라, styles/ 하위를 빼면 CSS 만
 *  버전 없는 고정 URL 이 돼 #1017 이 고친 '강제 새로고침해야 반영'이 CSS 에서 되살아난다.
 *  ⚠ #1313 R28/R29 — app/ 은 **재귀**로 훑는다. web/lib/ 분해로 public/app/lib/*.js 가 생겼는데
 *   비재귀면 그 파일들이 빌드버전 입력에서 빠져, 'lib 만 고친 배포'에서 버전이 안 올라 브라우저가
 *   immutable(1년) 로 캐시된 옛 모듈을 계속 쓴다. 하필 분해의 목적이 '이 파일만 바뀐다' 라서
 *   정확히 그 시나리오가 흔해진다. 하위 디렉터리가 늘어도 자동으로 잡히도록 재귀가 정답.
 */
export function listLocalAssets(publicDir: string): string[] {
  const out: string[] = [];
  const norm = (p: string): string => p.split(path.sep).join("/");
  try { for (const f of readdirSync(publicDir)) if (/\.(?:js|mjs|css)$/.test(f)) out.push(f); } catch { /* noop */ }
  try {
    for (const f of readdirSync(path.join(publicDir, "app"), { recursive: true }) as string[])
      if (/\.(?:js|mjs)$/.test(String(f))) out.push(`app/${norm(String(f))}`);
  } catch { /* noop */ }
  try {
    for (const f of readdirSync(path.join(publicDir, "styles"), { recursive: true }) as string[])
      if (/\.css$/.test(String(f))) out.push(`styles/${norm(String(f))}`);
  } catch { /* noop */ }
  return out.sort();
}

/** 재계산이 필요한지만 판단하는 값싼 지문(size+mtime). **정답성 근거가 아니다** — 최적화다. */
export function assetFingerprint(publicDir: string, files: string[]): string {
  let fp = "";
  for (const rel of files) {
    try { const s = statSync(path.join(publicDir, rel)); fp += `${rel}:${s.size}:${Math.floor(s.mtimeMs)};`; } catch { /* 사라진 파일 무시 */ }
  }
  return fp;
}

/**
 * 빌드버전: 자산 콘텐츠의 통합 sha256(앞 12자).
 *
 * ★ 이름도 함께 센다(`rel \0 내용`) — 내용이 같은 채로 파일이 **옮겨지기만** 해도 URL 이 달라지므로
 *  세대가 올라야 한다. 이름을 빼면 rename 배포가 immutable 캐시를 그대로 두고 넘어간다.
 */
export function computeAssetVersion(publicDir: string, files: string[] = listLocalAssets(publicDir)): string {
  const h = createHash("sha256");
  for (const rel of files) {
    try { h.update(rel).update("\0").update(readFileSync(path.join(publicDir, rel))); } catch { /* noop */ }
  }
  return h.digest("hex").slice(0, 12);
}
