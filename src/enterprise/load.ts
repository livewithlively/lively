// Enterprise(EE) 모듈 적재기 — 부팅 시 한 번. ee/ 가 있으면 훅을 등록하고, 없으면 조용히 넘어간다.
//
// ⚠ import 경로를 **변수**로 두는 것이 이 파일의 핵심이다. 리터럴로 쓰면 TypeScript 가 정적으로 모듈을
//  해석하려 들어서, src/ee 를 삭제한 무료 배포판이 컴파일되지 않는다. 변수 경로는 런타임 해석이라
//  ee 유무와 무관하게 코어가 빌드된다(B안 = 진짜 오픈코어의 성립 조건).
import { isEnterpriseLoaded } from "./registry.js";
import { logger } from "../log.js";

// dist 기준 상대경로 — dist/enterprise/load.js → dist/ee/register.js
const EE_ENTRY = "../ee/register.js";

/** ee/register.js 를 찾아 훅을 등록한다. 반환값 = EE 적재 여부. */
export async function loadEnterprise(): Promise<boolean> {
  if (isEnterpriseLoaded()) return true;
  try {
    const mod = (await import(EE_ENTRY)) as { registerEnterpriseModule?: () => void };
    if (typeof mod.registerEnterpriseModule !== "function") {
      logger.warn("ee/register.js 를 찾았지만 registerEnterpriseModule 이 없습니다 — EE 미적재로 진행");
      return false;
    }
    mod.registerEnterpriseModule();
    logger.info("Enterprise 모듈 적재됨(src/ee) — 컴플라이언스 기능 활성");
    return true;
  } catch {
    // ee 미탑재(무료 배포판)가 정상 경로다 — 에러가 아니라 구성 정보로 남긴다.
    logger.info("Enterprise 모듈 없음 — 코어(AGPL) 기능만 활성");
    return false;
  }
}
