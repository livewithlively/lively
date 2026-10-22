// v2/app-versions.ts — 앱의 **판 이력과 되돌리기**(#4600, 프로젝트 #4592 「장표 수정 앱」).
//
//  앱을 AI 에게 시켜 고치면(app_save) 워크스페이스 판이 쌓인다(1판 = 원본·릴리스, 2판 = 첫 고침 …). 마음에 안 들면 어느 판으로든,
//  원본으로도 돌아간다. 서버가 정본(app_versions · app_revert — SPEC §1-3)이고 여기는 그 자리에 뜨는 작은 메뉴와 호출뿐이다.
//  판 이력 창을 따로 만들지 않고 우클릭 메뉴(ctx-menu)를 빌려 쓴다 — 줄마다 «N판 · 요지 / 누가 · 언제» 이고 누르면 그 판으로.
import { api, toast } from '../core.js';
import { ctxMenu } from './panes-kit.js';
import { originVersionNo, previousVersionNo, versionRows, type AppVersion } from '../lib/app-menu.js';
import { verJ } from '../lib/studio-flow.js';
export type { AppVersion };

const appPath = (id: string, tail: string): string => '/api/ui/apps/' + encodeURIComponent(id) + tail;

export async function fetchAppVersions(appId: string): Promise<AppVersion[]> {
  const out: any = await api(appPath(appId, '/versions'));
  return Array.isArray(out?.versions) ? out.versions : [];
}

/**
 * 그 판으로 되돌린다. 돌려주는 값 = 되돌린 판 번호(실패면 null · 이유는 toast).
 *  부르는 쪽(붙은 앱 탭)이 이 번호로 프레임을 **바로** 다시 띄운다 — 서버의 'updated' 사건(SSE)에만 기대지 않는다(스트림이 없는 게이트웨이도 있다).
 *  사건이 뒤따라 오면 같은 번호라 두 번 띄우지 않는다(session-app-pane).
 */
export async function revertApp(appId: string, versionNo: number, title?: string, opts?: { publish?: boolean }): Promise<number | null> {
  try {
    //  #4667 publish — 되돌린 판을 바로 모두의 판으로(앱빌더 배포 설정 「이 판으로」). 없으면 공개 앱에선 되돌린 사람의 초안이 된다.
    const out: any = await api(appPath(appId, '/revert'), { method: 'POST', body: JSON.stringify({ version_no: versionNo, ...(opts && opts.publish ? { publish: true } : {}) }) });
    const draft = out && out.state === 'draft';
    //  #4632 앱빌더에서도 부른다 — 판 번호는 앱빌더의 버전 이름으로(초안 · V2 …, lib/studio-flow verJ).
    toast(`「${title || appId}」 앱을 ${verJ(versionNo, '으로')} 되돌렸어요. 앱 데이터는 그대로예요.` + (draft ? ' 이 버전은 나만 볼 수 있어요. 모두에게 공개하려면 「공개하기」를 눌러주세요.' : ''));
    return versionNo;
  } catch (e: any) { toast('되돌리지 못했어요. ' + (e && e.message ? e.message : e), true); return null; }
}

/** 지금 판의 바로 앞 판으로(방금 고침 띠의 「되돌리기」). 앞 판이 없으면 말해 준다. 돌려주는 값 = 되돌린 판 번호 또는 null. */
export async function revertToPrevious(appId: string, title?: string): Promise<number | null> {
  const versions = await fetchAppVersions(appId).catch(() => [] as AppVersion[]);
  const prev = previousVersionNo(versions);
  if (prev == null) { toast('되돌릴 이전 버전이 없어요. 이 버전이 처음이에요.'); return null; }
  return revertApp(appId, prev, title);
}

/** 원본(릴리스) 판으로. 빌트인에서 갈라진 앱이 아니면 할 일이 없다. 돌려주는 값 = 되돌린 판 번호 또는 null. */
export async function revertToOrigin(appId: string, title?: string): Promise<number | null> {
  const versions = await fetchAppVersions(appId).catch(() => [] as AppVersion[]);
  const origin = originVersionNo(versions);
  if (origin == null) { toast('이 앱은 라이블리 원본에서 바뀐 버전이 없어요. 지금이 원본이에요.'); return null; }
  return revertApp(appId, origin, title);
}

/** 판 이력 메뉴 — 그 자리(x, y)에 뜬다. 줄을 누르면 그 판으로 되돌리고, 되돌린 판 번호를 onReverted 로 알린다(부르는 쪽이 프레임을 다시 띄운다). */
export async function openVersionsMenu(x: number, y: number, app: { id: string; title: string }, onReverted?: (versionNo: number) => void): Promise<void> {
  let versions: AppVersion[] = [];
  try { versions = await fetchAppVersions(app.id); }
  catch (e: any) { toast('버전 이력을 불러오지 못했어요. ' + (e && e.message ? e.message : e), true); return; }
  if (!versions.length) { toast('아직 고친 버전이 없어요. 세션에 「이 앱을 이렇게 고쳐 줘」라고 말하면 새 버전이 생겨요.'); return; }
  const rows = versionRows(versions, (n) => { void revertApp(app.id, n, app.title).then((v) => { if (v != null) onReverted?.(v); }); });
  ctxMenu(x, y, rows, { title: `「${app.title}」 버전 이력`, sub: '누르면 그 버전으로 되돌려요. 데이터는 그대로예요.', minWidth: 260 });
}
