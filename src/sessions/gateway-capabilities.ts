// 게이트웨이만 가진 능력의 **등록소** (#2165) — 노드 에이전트 번들에서 DB·자격 코드를 떼어내는 이음매.
//
// 왜 이게 필요한가. 노드 에이전트는 'DB 없음'이 계약인데, 노드가 도달하는 모듈(`terminal/sessions.ts`,
//  `project/project-provision.ts`)이 게이트웨이 전용 함수를 **정적으로 import** 하고 있었다. 런타임은 그 규칙을
//  지켰지만(노드는 그 분기를 안 타거나 `.catch` 로 넘어간다) **번들은 그 코드를 통째로 실어 날랐다** —
//  실측: GitHub App 서명·설치토큰 발급·멤버 시크릿 금고·OAuth 브로커가 멤버 PC 로 배포되는 번들에 들어 있었다.
//
// ⚠ `await import()` 로는 못 뗀다. esbuild 는 outfile 하나(코드 분할 없음)면 동적 import 를 같은 번들에
//  인라인한다(#2165 실측). 번들에서 빼는 유일한 길은 **정적 참조를 없애는 것** — 그래서 '부르는 쪽이 구현을
//  import 하는' 방향을 뒤집어, 게이트웨이가 부팅 때 자기 구현을 여기 꽂는다(`src/index.ts`).
//
// 계약:
//  · 노드에서는 **아무도 등록하지 않는다** → 값이 undefined → 호출부는 종전의 '없음' 분기를 탄다
//    (노드는 원래 그 분기를 타고 있었다. 이 파일은 그 사실을 타입으로 적었을 뿐이다).
//  · 게이트웨이에서 등록이 빠지면 **조용히 기능이 죽는다**(자격이 안 뿌려지고 clone 이 인증 없이 돈다).
//    그게 이 설계의 유일한 위험이라 두 겹으로 막는다 — ⓐ `gatewayCapability()` 가 게이트웨이에서만 크게 운다
//    ⓑ `scripts/gateway-capabilities-wired.test.mjs` 가 선언된 능력이 전부 index.ts 에서 등록되는지 소스로 못박는다.
//
// ⚠ 여기엔 **런타임 import 를 넣지 마라.** 타입 전용(`import type`)만 허용된다 — tsc 가 지우므로 번들 간선이
//  아니다(그 불변식은 scripts/node-agent-bundle-boundary.test.mjs 가 못박는다).

import type { GitCredentialSecret } from "../org/credentials/git-credential-store.js";   // 타입 전용 — 런타임 간선 아님
// ⚠ 위 「런타임 import 금지」의 유일한 예외(#2599 T2). exec-topology 는 **import 가 0 인 순수 잎**이고
//  이 번들에 이미 실려 있다(terminal-isolation·sessions·session-state 가 쓴다) — 즉 이 간선은 번들에
//  아무것도 더 끌어오지 않는다. 그 불변식(잎의 순수함)은 exec-topology-single-source 시험 S3 가 지킨다.
import { onNode } from "../exec-topology.js";

export interface GatewayCapabilities {
  /** 멤버의 등록 git 자격을 그 홈에 반영한다(세션 시작 경로). DB 를 탄다 → 게이트웨이 전용. */
  materializeMemberGit?: (osUser: string, memberId: string) => Promise<void>;
  /** 이 멤버/호스트의 git 자격을 해소한다(레지스트리·금고·GitHub App 폴백). DB 를 탄다 → 게이트웨이 전용. */
  resolveGitSecret?: (memberId: string | null, host: string, opts?: { repoFullName?: string | null }) => Promise<GitCredentialSecret | null>;
  /** 멤버 키트 시딩이 쓰는 바깥 데이터(멤버 조회 · 설치 번들 생성). DB·번들 생성을 탄다 → 게이트웨이 전용. */
  kitSeedDeps?: {
    getMember: (id: string) => Promise<{ scopes?: string[] | null } | null>;
    buildBundle: () => Promise<Buffer>;
  };
  /** 앱 세션 토큰 발급. DB 를 탄다 → 게이트웨이 전용(노드는 게이트웨이가 발급해 실어 보낸 토큰을 쓴다). */
  mintAppToken?: (memberId: string, appId: string, reason: string) => Promise<{ token: string }>;
  /** 앱 하네스 자산을 조직 저장소에서 읽어 물질화. DB 를 탄다 → 게이트웨이 전용(노드는 prepared 자산을 쓴다). */
  materializeAppAssets?: (sessionHome: string, appId: string, writer: unknown) => Promise<void>;
  /** 노드에 실어 보낼 자격 리스(조직 폴백 없음). DB 를 탄다 → 게이트웨이 전용. */
  leaseGitSecretForNode?: (requesterId: string, host: string, nodeKind: "worker" | "member") => Promise<GitCredentialSecret | null>;
}

/** 선언된 능력 이름 — 배선 가드가 이 목록으로 index.ts 를 검사한다(추가하면 가드가 자동으로 요구한다). */
export const GATEWAY_CAPABILITY_NAMES = ["materializeMemberGit", "resolveGitSecret", "leaseGitSecretForNode", "kitSeedDeps", "mintAppToken", "materializeAppAssets"] as const;

const caps: GatewayCapabilities = {};

/** 게이트웨이 부팅이 자기 구현을 꽂는다. 노드는 부르지 않는다. */
export function registerGatewayCapabilities(impl: GatewayCapabilities): void {
  Object.assign(caps, impl);
}

/**
 * 능력 하나를 꺼낸다. 없으면 undefined — 호출부는 '없음' 분기를 타야 한다(던지지 않는다).
 *  게이트웨이인데 없으면 **한 번 크게 운다**: 등록을 빠뜨린 사고는 조용하면 몇 주 안 들킨다
 *  (자격이 안 뿌려져도 세션은 뜨고, 공개 레포는 그냥 clone 된다 — 사설 레포에서만 터진다).
 */
const warned = new Set<string>();
export function gatewayCapability<K extends keyof GatewayCapabilities>(name: K): GatewayCapabilities[K] {
  const fn = caps[name];
  if (!fn && !onNode() && !warned.has(name as string)) {
    warned.add(name as string);
    console.error(`[gateway-capabilities] '${String(name)}' 이 등록되지 않았다 — 게이트웨이인데 이 능력이 없으면 `
      + "git 자격이 조용히 빠진다(사설 레포 clone·세션 자격 주입 실패). src/index.ts 의 registerGatewayCapabilities 를 확인하라.");
  }
  return fn;
}
