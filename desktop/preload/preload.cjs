// preload (#1541 T2) — 렌더러에 **딱 필요한 것만** 노출한다.
//
// ⚠ CommonJS(.cjs) 인 이유: `sandbox: true` 인 preload 는 CommonJS 로만 로드된다(ESM 미지원).
// ⚠ 채널 이름을 여기에 다시 적지 않는다 — ipc-contract.mjs 가 단일 출처지만 sandbox preload 는 임의 모듈을
//  import 할 수 없다. 그래서 **문자열을 인라인하되 계약 테스트로 두 곳이 어긋나지 않게 못박는다**
//  (desktop-core.test.mjs 의 preload 계약 케이스).
const { contextBridge, ipcRenderer } = require("electron");

const IPC = {
  GET_STATE: "lively:get-state",
  RUN: "lively:run",
  CANCEL: "lively:cancel",
  ANSWER: "lively:answer",
  SET_GATEWAY: "lively:set-gateway",
  OPEN_EXTERNAL: "lively:open-external",
  STATE: "lively:state",
  PROGRESS: "lively:progress",
  LOG: "lively:log",
};

// 노출은 **함수만**. ipcRenderer 자체를 넘기면 렌더러가 임의 채널로 메인을 부를 수 있다.
contextBridge.exposeInMainWorld("lively", {
  getState: () => ipcRenderer.invoke(IPC.GET_STATE),
  run: (kind, opts) => ipcRenderer.invoke(IPC.RUN, { kind, opts }),
  cancel: () => ipcRenderer.invoke(IPC.CANCEL),
  answer: (id, value) => ipcRenderer.invoke(IPC.ANSWER, { id, value }),
  setGateway: (url) => ipcRenderer.invoke(IPC.SET_GATEWAY, { url }),
  openExternal: (url) => ipcRenderer.invoke(IPC.OPEN_EXTERNAL, { url }),
  onState: (cb) => ipcRenderer.on(IPC.STATE, (_e, s) => cb(s)),
  onProgress: (cb) => ipcRenderer.on(IPC.PROGRESS, (_e, p) => cb(p)),
  onLog: (cb) => ipcRenderer.on(IPC.LOG, (_e, l) => cb(l)),
});
