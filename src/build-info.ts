// 배포된 산출물의 신원(#1289) — "지금 도는 게 몇 버전인가"를 밖에서 한 번에 알 수 있게.
//
// 계기(2026-08-04 실측): 게이트웨이가 "배포 이전으로 되돌아간 것 같다"는 의심이 들었는데 확인할 방법이
//  없었다. package.json 의 version 은 0.1.0 고정(릴리스 버전은 git 태그로만 존재하고 번들에 안 박힌다),
//  번들엔 .git 도 없고, /readyz 는 디스크·DB 만 준다. 결국 **기능 지문을 grep 해 추측**해야 했고
//  그 과정에서 구 경로를 보고 틀린 결론까지 냈다(실행 경로는 blue/green 의 심링크였다).
//  실제로 두 릴리스가 유실된 롤백이 있었는데 한참 뒤에야 알았다.
//
// 설계:
//  · **빌드 시점에 박는다** — 런타임 추론은 이번처럼 틀린다. release.yml 이 번들 루트에 build-info.json 을 쓴다.
//  · **없어도 죽지 않는다** — 소스 실행(개발)·구 번들엔 파일이 없다. 그땐 null 을 정직하게 낸다.
//    버전 표시가 기동을 막으면 본말전도다.
//  · **package.json 은 안 건드린다** — package-lock.json 에 루트 version 이 함께 있어 어긋나면 `npm ci` 가
//    깨진다. 배포의 첫 단계가 버전 표시 때문에 죽으면 안 된다.
//  · **경로는 모듈 기준** — cwd 가 아니다. blue/green 심링크·다른 cwd 로 띄워도 자기 번들의 파일을 읽어야 한다.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface BuildInfo {
  version: string | null;      // 릴리스 태그(vX.Y.Z). 모르면 null — 거짓 값을 지어내지 않는다.
  commit: string | null;
  built_at: string | null;
}

const UNKNOWN: BuildInfo = { version: null, commit: null, built_at: null };

// 문자열만 통과시킨다(주입 표면 축소 — 이 값은 미인증 /readyz 로 나간다).
export function parseBuildInfo(raw: unknown): BuildInfo {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return UNKNOWN;
  const o = raw as Record<string, unknown>;
  const s = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, 200) : null);
  return { version: s(o.version), commit: s(o.commit), built_at: s(o.built_at) };
}

// 번들 루트 = 이 모듈(dist/build-info.js)의 한 단계 위. 소스 실행이면 src/ 의 위 = 레포 루트.
export function buildInfoPath(moduleUrl: string): string {
  return path.join(path.dirname(fileURLToPath(moduleUrl)), "..", "build-info.json");
}

let cached: BuildInfo | null = null;
export function buildInfo(): BuildInfo {
  if (cached) return cached;                       // 매 요청 디스크를 읽지 않는다
  try {
    cached = parseBuildInfo(JSON.parse(readFileSync(buildInfoPath(import.meta.url), "utf8")));
  } catch {
    cached = UNKNOWN;                              // 파일 없음·JSON 깨짐 모두 여기로(fail-soft)
  }
  return cached;
}
