// v2/app-versions.ts — 앱의 **판 이력과 되돌리기**(#4600, 프로젝트 #4592 「장표 수정 앱」).
//
//  앱을 AI 에게 시켜 고치면(app_save) 워크스페이스 판이 쌓인다(1판 = 원본·릴리스, 2판 = 첫 고침 …). 마음에 안 들면 어느 판으로든,
//  원본으로도 돌아간다. 서버가 정본(app_versions · app_revert — SPEC §1-3)이고 여기는 그 자리에 뜨는 작은 메뉴와 호출뿐이다.
//  판 이력 창을 따로 만들지 않고 우클릭 메뉴(ctx-menu)를 빌려 쓴다 — 줄마다 «N판 · 요지 / 누가 · 언제» 이고 누르면 그 판으로.
import { api, toast } from '../core.js';
import { ctxMenu } from './panes-kit.js';
import { originVersionNo, previousVersionNo, versionRows, type AppVersion } from '../lib/app-menu.js';
export type { AppVersion };

const appPath = (id: string, tail: string): string => '/api/ui/apps/' + encodeURIComponent(id) + tail;

export async function fetchAppVersions(appId: string): Promise<AppVersion[]> {
  const out: any = await api(appPath(appId, '/versions'));
  return Array.isArray(out?.versions) ? out.versions : [];
}

/** 그 판으로 되돌린다. 성공하면 서버가 'updated' 사건을 밀어 붙은 앱 탭이 스스로 다시 뜬다(session-app-pane). 실패는 toast. */
export async function revertApp(appId: string, versionNo: number, title?: string): Promise<boolean> {
  try {
    await api(appPath(appId, '/revert'), { method: 'POST', body: JSON.stringify({ version_no: versionNo }) });
    toast(`「${title || appId}」을(를) ${versionNo}판으로 되돌렸어요 — 문서·의견 데이터는 그대로예요.`);
    return true;
  } catch (e: any) { toast('되돌리지 못했어요 — ' + (e && e.message ? e.message : e), true); return false; }
}

/** 지금 판의 바로 앞 판으로(방금 고침 띠의 「되돌리기」). 앞 판이 없으면 말해 준다. */
export async function revertToPrevious(appId: string, title?: string): Promise<boolean> {
  const versions = await fetchAppVersions(appId).catch(() => [] as AppVersion[]);
  const prev = previousVersionNo(versions);
  if (prev == null) { toast('되돌릴 앞 판이 없어요 — 이 판이 처음이에요.'); return false; }
  return revertApp(appId, prev, title);
}

/** 원본(릴리스) 판으로. 빌트인에서 갈라진 앱이 아니면 할 일이 없다. */
export async function revertToOrigin(appId: string, title?: string): Promise<boolean> {
  const versions = await fetchAppVersions(appId).catch(() => [] as AppVersion[]);
  const origin = originVersionNo(versions);
  if (origin == null) { toast('이 앱은 라이블리 원본에서 갈라진 판이 없어요 — 지금이 원본이에요.'); return false; }
  return revertApp(appId, origin, title);
}

/** 판 이력 메뉴 — 그 자리(x, y)에 뜬다. 줄을 누르면 그 판으로 되돌린다. */
export async function openVersionsMenu(x: number, y: number, app: { id: string; title: string }, onReverted?: () => void): Promise<void> {
  let versions: AppVersion[] = [];
  try { versions = await fetchAppVersions(app.id); }
  catch (e: any) { toast('판 이력을 불러오지 못했어요 — ' + (e && e.message ? e.message : e), true); return; }
  if (!versions.length) { toast('아직 고친 판이 없어요 — 세션에 「이 앱을 이렇게 고쳐 줘」라고 말하면 판이 생겨요.'); return; }
  const rows = versionRows(versions, (n) => { void revertApp(app.id, n, app.title).then((ok) => { if (ok) onReverted?.(); }); });
  ctxMenu(x, y, rows, { title: `「${app.title}」 판 이력`, sub: '누르면 그 판으로 되돌려요 · 데이터는 그대로', minWidth: 260 });
}
