// 수집 실행 세션의 **판 명령·크기** (#4213 T11) — 세션 생성(createSession)이 쓰는 잎 모듈이다(순수 · 의존 없음).
//  노드 에이전트 번들에도 실린다(createSession 이 노드에서도 돈다) — 그래서 러너 스크립트 문자열(collect-run-script.ts)과 떼어 둔다.

/** 실행 폴더의 부모(멤버 홈 기준). */
export const COLLECT_PARENT = ".cache/lvly-collect";
/**
 * 수집 세션 크기(MB) — 캡 768 · 예약 512(잠정). 캡은 일반 세션(1,536)의 절반이다(확정판 §5).
 *  예약은 처음에 384 였는데, 매니지드 실측(2026-10-16)에서 최소 실행만으로 컨테이너 사용이 +389~450MB 늘어 512 로 올렸다.
 *  실제 수집(여러 턴·큰 결과)을 재서 다시 정한다. env 로 덮을 수 있다(LIVELY_COLLECT_MEM_MB · LIVELY_COLLECT_MEM_REQUEST_MB).
 *  예약은 캡을 넘지 않는다.
 */
export function collectMemLimits(env: NodeJS.ProcessEnv = process.env): { maxMb: number; requestMb: number } {
  const num = (v: string | undefined, d: number): number => {
    const n = Number(v);
    return Number.isInteger(n) && n >= 128 && n <= 8192 ? n : d;
  };
  const maxMb = num(env.LIVELY_COLLECT_MEM_MB, 768);
  return { maxMb, requestMb: Math.min(num(env.LIVELY_COLLECT_MEM_REQUEST_MB, 512), maxMb) };
}

/**
 * (순수) 세션 판 명령의 재료가 될 폴더인가 — 절대 경로 · `<홈>/.cache/lvly-collect/<실행 id>` 꼴 · 위로 빠지는 조각 없음.
 *  createSession 이 이 값으로 판 명령을 만들므로 여기서 좁힌다(셸 메타문자·공백이 들어올 자리가 없다).
 */
export function isCollectRunDir(dir: string): boolean {
  const d = String(dir || "");
  if (!d.startsWith("/") || d.split("/").some((p) => p === "..")) return false;
  return /^\/[A-Za-z0-9._/-]+\/\.cache\/lvly-collect\/cr-\d{14}-[a-z0-9]{6}$/.test(d);
}

/** (순수) 수집 세션의 판 명령 — 러너 하나. 끝나면 판이 닫힌다(셸로 남지 않는다 — 남으면 컨테이너가 안 걷힌다). */
export function collectPaneArgv(dir: string): string[] {
  if (!isCollectRunDir(dir)) throw new Error(`수집 실행 폴더 형식 오류: ${dir}`);
  return ["node", `${dir}/run.cjs`, dir];
}
