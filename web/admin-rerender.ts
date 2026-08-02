// admin-rerender.ts — 관리탭 패널 재렌더 레지스트리 (#1313 R37, admin.ts 에서 분리).
//  왜 있나: 관리탭 패널들은 저장·삭제 뒤 **자기 자리만** 다시 그린다. 종전엔 그 재렌더를 셸(admin.ts)의
//  디스패처를 역호출해서 했고(20+곳), 그래서 패널을 다른 파일로 떼어내는 순간 패널→셸 import 가 생겨
//  셸↔패널 순환이 됐다. 여기서 키→렌더 함수 표를 들고 있으면 패널은 셸을 몰라도 자기를 다시 그릴 수 있다.
//
//  ⚠ 재렌더가 쓰는 데이터는 **state.admin.data 의 최신본**이다 — 호출부가 loadAdmin(true) 로 갱신한 뒤
//   그 값을 넘기는 기존 계약을 그대로 둔다(data 를 생략하면 지금의 state.admin.data 를 쓴다).
import { api, state } from './core.js';

async function loadAdmin(force?) {
  if (!state.admin.data || force) state.admin.data = await api('/api/ui/org');
  return state.admin.data;
}

// host = 다시 그릴 자리(DOM), data = 관리 데이터(생략 시 state.admin.data 최신본).
type PanelRender = (host: any, data: any) => any;
const PANELS = new Map<string, PanelRender>();

function registerPanel(key: string, render: PanelRender): void {
  PANELS.set(key, render);
}
// 등록되지 않은 키는 조용히 무시한다 — 옛 if-체인이 아무 분기에도 안 걸리고 빠져나가던 것과 같은 동작.
function rerenderPanel(host: any, key: string, data?: any): void {
  const render = PANELS.get(key);
  if (!render) return;
  render(host, data === undefined ? state.admin.data : data);
}

export {
  loadAdmin,
  registerPanel,
  rerenderPanel,
};
