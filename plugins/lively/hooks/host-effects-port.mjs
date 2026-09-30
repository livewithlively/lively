// 소스 트리(kit/hooks → kit/setup)와 설치 트리(~/.lively/hooks → ~/.lively/lib)를 잇는 얇은 포트.
// 훅은 평평하게 복사되므로 일반 상대 import 하나로 두 환경을 동시에 가리킬 수 없다.
let implementation;
try {
  implementation = await import("../setup/host-effects.mjs");
} catch {
  implementation = await import("../lib/host-effects.mjs");
}

export const hostEffects = implementation.entrypointHostEffects();
