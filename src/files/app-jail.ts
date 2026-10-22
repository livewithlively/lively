// 앱 폴더 봉쇄(#4673) — 앱 폴더 주소(apps/<앱>/…)는 **그 앱 폴더**(<apps 자리>/<앱>) 안에서만 연다. 서명 주소 받는 곳과 홈 탐색기가 같이 쓴다.
//  대상 경로를 apps 자리 기준으로 한 번 해소하고(링크를 따라간 실제 자리), 그 결과가 <apps 자리의 실제 자리>/<앱> 자신이거나 그 안이어야 한다 —
//   앱 폴더 자신이 다른 곳을 가리키는 링크여도, 그 안의 링크가 밖을 가리켜도 같은 한 판정에 걸린다.
//  해소는 op 가 실제로 도는 자리에서 한다(path-jail 의 probe — 격리면 그 구성원 uid). 매니지드에선 probe 한 번이 파일 작업 헬퍼 왕복 한 번이라
//   한 번만 부른다(path-jail.isConfined 와 같은 자세 — 첫 화면 목록에 왕복을 더하지 않는다).
import path from "node:path";
import { confined, type PathProbe } from "../terminal/path-jail.js";

export type Probe = (base: string, target: string) => Promise<PathProbe>;

export async function isInAppFolder(appsBase: string, app: string, abs: string, probe: Probe): Promise<boolean> {
  const p = await probe(appsBase, abs);
  if (!confined(p)) return false;   // apps 자리 밖 · 댕글링 · 해소 실패 → 거부
  if (p.base === null) return true; // 자리가 아직 없다 — 그 밑에 아무것도 없다(글자 판정으로 충분 · path-jail.confined 와 같은 규칙)
  const resolved = p.rest.length ? path.resolve(p.real as string, ...p.rest) : path.resolve(p.real as string);
  const appDir = path.join(path.resolve(p.base), app);
  return resolved === appDir || resolved.startsWith(appDir + path.sep);
}
