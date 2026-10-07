// 빌트인 앱 패키지 폴더(apps/builtin) 의 자리 — 모듈 기준(cwd 무관: blue/green 심링크·다른 cwd 에서도 자기 레포의 파일을 읽는다).
//  seed.ts(부팅 시딩)와 app-versions.ts(app_pull · 원본으로 되돌리기, #4600)가 같은 자리를 봐야 해서 한 곳에 둔다.
//  경로: 이 모듈(dist/apps/builtin-root.js)의 두 단계 위 = 레포 루트. apps/builtin 은 src 밖(코드 소유 데이터)이라 컴파일되지 않고 그대로 있다.
import path from "node:path";
import { fileURLToPath } from "node:url";

export function builtinAppsRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "apps", "builtin");
}

/** apps/builtin/<id>. id 는 매니페스트 규칙(소문자 영숫자·-)을 이미 통과한 값만 넘긴다 — 경로 조립에 그대로 쓴다. */
export function builtinAppDir(id: string, root: string = builtinAppsRoot()): string {
  return path.join(root, id);
}
