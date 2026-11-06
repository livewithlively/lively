// 그림 변환 워커 — 디코드가 CPU 를 수 초 붙드는 동기 일이라(8192×8192 PNG 3.4초 실측) 게이트웨이 이벤트 루프에서 돌리지 않는다.
//  입력·출력 계약은 image-transform.ts 의 renderJpeg 에 있다.
import { parentPort, workerData } from "node:worker_threads";
import { renderJpeg, type RenderInput } from "./image-transform-core.js";

void (async () => {
  try {
    const out = await renderJpeg(workerData as RenderInput);
    parentPort?.postMessage({ ok: true, ...out });
  } catch (e) {
    parentPort?.postMessage({ ok: false, error: (e as Error)?.message ?? String(e) });
  }
})();
