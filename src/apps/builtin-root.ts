// 빌트인 앱 패키지 폴더(apps/builtin) 의 자리 — 모듈 기준(cwd 무관: blue/green 심링크·다른 cwd 에서도 자기 레포의 파일을 읽는다).
//  seed.ts(부팅 시딩)와 app-versions.ts(app_pull · 원본으로 되돌리기, #4600)가 같은 자리를 봐야 해서 한 곳에 둔다.
//  경로: 이 모듈(dist/apps/builtin-root.js)의 두 단계 위 = 레포 루트. apps/builtin 은 src 밖(코드 소유 데이터)이라 컴파일되지 않고 그대로 있다.
import path from "node:path";
import { fileURLToPath } from "node:url";

let rootForTest: string | null = null;

/**
 * **시험 전용** — 픽스처 폴더를 빌트인 앱 자리로 본다(null 이면 되돌린다). 제품 코드는 부르지 않는다.
 *  왜: 시더는 폴더를 인자로 받지만, app_pull · app_revert(«원본으로») 능력은 인자가 없어 늘 이 모듈의 자리를 본다.
 *  이음매가 없으면 통합 시험이 픽스처를 시딩해 놓고도 되돌리기가 «폴더 없음» 대체 경로를 타, 정작 재려던 길(릴리스에서 재설치)을 못 잰다
 *  (2026-10-07 CI 실측: app-versions.pg-test P6).
 */
export function setBuiltinAppsRootForTest(root: string | null): void { rootForTest = root; }

export function builtinAppsRoot(): string {
  return rootForTest ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "apps", "builtin");
}

/** apps/builtin/<id>. id 는 매니페스트 규칙(소문자 영숫자·-)을 이미 통과한 값만 넘긴다 — 경로 조립에 그대로 쓴다. */
export function builtinAppDir(id: string, root: string = builtinAppsRoot()): string {
  return path.join(root, id);
}
