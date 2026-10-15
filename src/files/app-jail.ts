// 앱 폴더 봉쇄(#4673) — 앱 폴더 주소(apps/<앱>/…)는 **그 앱 폴더**(<apps 자리>/<앱>) 안에서만 연다. 서명 주소 받는 곳과 홈 탐색기가 같이 쓴다.
//  두 겹을 본다: ① 앱 폴더 자신의 실제 자리가 정확히 <apps 자리의 실제 자리>/<앱> 이다(앱 폴더가 다른 곳을 가리키는 링크가 아니다)
//   ② 대상 경로가 링크를 해소한 뒤에도 그 앱 폴더 안이다. 해소는 op 가 실제로 도는 자리에서 한다(path-jail 의 probe — 격리면 그 구성원 uid).
import path from "node:path";
import { confined, isConfined, type PathProbe } from "../terminal/path-jail.js";

export type Probe = (base: string, target: string) => Promise<PathProbe>;

export async function isInAppFolder(appsBase: string, app: string, abs: string, probe: Probe): Promise<boolean> {
  const appDir = path.join(appsBase, app);
  const p = await probe(appsBase, appDir);
  if (!confined(p)) return false;
  //  자리가 아직 없으면(base:null) 그 밑에 아무것도 없다 — 글자 판정으로 충분하다(path-jail.confined 와 같은 규칙).
  if (p.base !== null) {
    const resolved = p.rest.length ? path.resolve(p.real as string, ...p.rest) : path.resolve(p.real as string);
    if (resolved !== path.join(path.resolve(p.base), app)) return false;
  }
  return isConfined(appDir, abs, probe);
}
