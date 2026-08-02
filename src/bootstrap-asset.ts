// 부트스트랩 전달 계약 (#1087) — 게이트웨이가 `/cli`(sh)·`/cli.ps1`(PowerShell) 로 내보내는 **본문**을 만든다.
//
// ⚠ 이 둘은 파일이 아니라 **문자열**로 인터프리터에 들어간다:
//     curl -fsSL <gw>/cli | sh        irm <gw>/cli.ps1 | iex
//   파일 실행이면 리더가 BOM(U+FEFF)을 인코딩 표식으로 소비해 파서엔 안 넘기지만, 문자열 경로엔
//   **1번 문자로 그대로 남는다**. 그러면 1행의 `#` 가 토큰 시작이 아니게 돼 주석이 아니라 **명령**이 되고,
//   PowerShell 에선 그 줄의 `(#864)` 안 `#` 가 닫는 `)` 를 주석으로 삼켜
//     Missing closing ')' in expression   (@ line 12, col 32)
//   로 설치가 통째로 죽는다. sh 도 같은 사정(1행이 `<BOM>#!/bin/sh` → command not found).
//   실측: 고객사 A 윈도우 박스에서 설치 자체가 불가능했다(그 박스만의 문제가 아니라 전 윈도우 사용자).
//
// ⚠ **mac/linux 개발 박스에선 절대 재현되지 않는 계열**이다(우리는 sh 를 파일로 안 돌리고, 개발자 에디터가
//   BOM 을 안 붙인다). 그래서 방어를 사람의 주의력이 아니라 코드+테스트에 둔다:
//     1차 = 소스 파일에 BOM 이 없다 (bootstrap-asset.test.ts 가 바이트로 강제)
//     2차 = 서빙 시점에 떼어낸다 (이 파일 — 윈도우 에디터가 되살려도 안 깨지게)

/** 선행 BOM(U+FEFF) 한 개를 떼어낸다. 없으면 원본 그대로. */
const stripBom = (s: string): string => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

/** 부트스트랩 소스에 서빙 시점 게이트웨이 주소를 굽는다(= 다운로더가 실제로 받는 바이트). */
export function bootstrapBody(src: string, gatewayUrl: string): string {
  return stripBom(src).replaceAll(GATEWAY_PLACEHOLDER, gatewayUrl);
}

/** 부트스트랩 소스가 게이트웨이 주소 자리에 박아두는 토큰. 소스와 서버가 같은 값을 써야 한다. */
export const GATEWAY_PLACEHOLDER = "__LIVELY_GATEWAY__";
