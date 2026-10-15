// 앱 화면(srcdoc · 앱 주소 lvly.app)이 제 앱 폴더의 서명 주소를 쓰게 CSP 에 열 자리(#4673).
//  앱 화면의 CSP 는 기본이 «네트워크 0» 이다(default-src 'none' · connect-src 는 선언한 곳만). lively.files.url 로 받은 서명 주소는
//   워크스페이스 주소(<slug>.app.lvly.io/api/files/s/…)라 그대로는 fetch · <img> 가 막힌다. 그래서 **앱 폴더를 선언한 앱에만**
//   그 경로 하나(`<게이트웨이>/api/files/s/`)를 connect · img · media 에 연다 — 토큰 없이는 아무것도 열리지 않는 자리라 바깥으로 새는 통로가 아니다.
//  경로까지 적는 까닭: 같은 출처의 다른 API(/api/ui/…)는 계속 막힌다(CSP 출처 식은 경로 접두를 본다).
import { gatewayUrl, SAFE_GATEWAY_URL } from "../gateway-url.js";
import { declaresAppFolder } from "./file-access.js";

export { declaresAppFolder };

/** 서명 주소의 경로 접두 — files/signed-routes 가 붙는 자리(index.ts `/api/files/s`). */
export const FILE_URL_PATH = "/api/files/s/";

/** (순수) 이 앱 화면의 CSP 에 더할 출처 식 — 선언이 없거나 게이트웨이 주소가 모양이 아니면 null. */
export function filesCspSourceFor(manifest: unknown, base: string | null): string | null {
  if (!declaresAppFolder(manifest) || !base || !SAFE_GATEWAY_URL.test(base)) return null;
  return base + FILE_URL_PATH;
}

/** 게이트웨이 공개 주소로 출처 식을 만든다(org 프로필 > PUBLIC_URL). */
export async function filesCspSource(manifest: unknown): Promise<string | null> {
  if (!declaresAppFolder(manifest)) return null;   // 대부분의 앱 — 게이트웨이 주소(DB)를 읽을 까닭이 없다
  return filesCspSourceFor(manifest, await gatewayUrl());
}
