// 수집 실행 세션의 **판 명령** (#4213 T11) — 세션 생성(createSession)이 쓰는 잎 모듈이다(순수 · 의존 없음).
//  크기(상한·예약)는 관리 화면에서 바꾸는 정책이다 — sessions/session-memory-policy.ts 의 collect_session_policy.
//  노드 에이전트 번들에도 실린다(createSession 이 노드에서도 돈다) — 그래서 러너 스크립트 문자열(collect-run-script.ts)과 떼어 둔다.

/** 실행 폴더의 부모(멤버 홈 기준). */
export const COLLECT_PARENT = ".cache/lvly-collect";
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
