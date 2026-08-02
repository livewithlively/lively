// 단독 터미널 페이지 모듈을 **노드에서 그대로 import** 하기 위한 최소 브라우저 스텁 (#1313 R51).
//  종전(손편집 public/terminal.js 시절): "브라우저용 클래식 스크립트라 import 할 수 없다" → 파일에서 함수 선언을
//   중괄호 깊이로 잘라 new Function 으로 평가했다(소스 텍스트 추출 해킹). 그 방식은 ① 이름/포맷이 조금만 바뀌어도 깨지고
//   ② 잘라낸 조각만 보므로 실제 모듈이 어떻게 조립되는지는 검증하지 못했다.
//  지금(web/standalone/terminal.ts): TS 모듈이라 진짜로 import 한다. 부팅(boot())은 번들 엔트리에 있어
//   import 만으로는 실행되지 않으므로, 최상위가 읽는 브라우저 전역 몇 개만 채워 주면 노드에서 로드된다.
//
//  ⚠ 대상은 tsc 산출 모듈(dist/standalone/terminal.js) — 브라우저 산출물(public/terminal.js)은 iife 번들이라
//   import 대상이 아니다. 둘은 같은 소스에서 나온다(npm run build).
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const MOD_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "standalone", "terminal.js");
export const MOD_URL = pathToFileURL(MOD_PATH).href;

const def = (obj, key, value) => Object.defineProperty(obj, key, { value, configurable: true, writable: true });

// 모듈 최상위가 읽는 전역만(그 이상은 일부러 두지 않는다 — 늘어나면 '브라우저 없이 못 읽는 코드'가 늘었다는 신호).
export function installBrowserStubs({ pathname = "/ui/terminal.html", search = "" } = {}) {
  const g = globalThis;
  def(g, "window", g);
  def(g, "self", g);
  def(g, "location", { pathname, search, protocol: "https:", host: "test" });
  def(g, "navigator", { vendor: "", userAgent: "node" });
  def(g, "document", { addEventListener() { /* flushPendingCopy 배선 */ }, removeEventListener() { /* noop */ } });
  def(g, "localStorage", { getItem: () => null, setItem() { /* noop */ }, removeItem() { /* noop */ } });
  def(g, "isSecureContext", false);
  def(g, "TERMJS_BUILD", "test"); // 브라우저 산출물엔 esbuild define 이 박는 값(빌드 스탬프)
}

// 매 호출마다 **새 모듈 인스턴스**(?n= 쿼리로 ESM 캐시 우회) — location 이 다른 상황(프리뷰 접두사 등)을
//  같은 프로세스에서 여러 번 평가하기 위한 것. 모듈 최상위 상태도 함께 초기화된다.
let seq = 0;
export async function importTerminalModule(opts) {
  installBrowserStubs(opts);
  return import(`${MOD_URL}?n=${++seq}`);
}
