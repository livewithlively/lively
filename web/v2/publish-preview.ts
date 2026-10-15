// v2/publish-preview.ts — 「공개하기」 전에 «이번 공개가 표에 무엇을 하는지» 보여 주고 확인을 받는다(#4732).
//
//  공개한 앱의 초안은 표를 더하는 일만 저장 때 하고, 칸 지우기 · 이름 · 종류 바꾸기 · 조이기는 공개할 때 한다(#4724). 그 목록이 지금까지는
//  저장한 사람의 저장 응답에만 왔다 — 책임자 · 관리자가 남의 초안을 공개할 때나 나중에 화면에서 공개할 때는 볼 길이 없었다.
//  서버(app_publish_preview)가 실제 공개와 같은 표 맞추기를 걸어 보고 되돌려 계산한다. 여기는 그 결과를 확인 창으로 보여 줄 뿐이다.
//   · 표에 할 일이 없으면 묻지 않는다(true — 지금처럼 바로 공개).
//   · 이대로면 공개가 멈추면(빈 행 · 겹친 값 · 가리킬 행 없음) 그 까닭을 보여 주고 false.
//   · 미리 보기를 못 하면 그래도 공개할지 묻는다 — 공개는 어긋나면 아무것도 바꾸지 않고 멈추므로 안전하다.
import { api } from '../core.js';
import { confirmDialog } from '../ui-primitives.js';

interface PublishPreview { changes?: string[]; blocked?: string[]; incomplete?: string | null }

/** versionNo — 그 판으로 되돌리고 바로 공개할 때(앱빌더 「이 판으로」). 돌려주는 값 = 공개해도 되나. */
export async function confirmPublish(appId: string, opts?: { versionNo?: number; title?: string }): Promise<boolean> {
  const name = opts && opts.title ? '「' + opts.title + '」' : '이 앱';
  let p: PublishPreview;
  try {
    p = await api('/api/ui/apps/' + encodeURIComponent(appId) + '/publish-preview', {
      method: 'POST', body: JSON.stringify(opts && opts.versionNo ? { version_no: opts.versionNo } : {}),
    }) as PublishPreview;
  } catch (e: any) {
    return confirmDialog({
      title: '표에 할 일을 확인하지 못했어요', message: e && e.message ? e.message : String(e),
      note: '그래도 공개할 수 있어요. 공개하다가 데이터가 새 규칙에 맞지 않으면 아무것도 바뀌지 않고 멈춰요.', confirmText: '그래도 공개하기',
    });
  }
  const changes = Array.isArray(p.changes) ? p.changes : [];
  const blocked = Array.isArray(p.blocked) ? p.blocked : [];
  if (blocked.length) {
    await confirmDialog({
      title: '이대로는 공개할 수 없어요',
      message: name + '에 새 규칙에 맞지 않는 행이 있어요. 그 행을 고친 뒤 다시 공개하세요. 지금은 아무것도 바뀌지 않았어요.',
      lines: blocked, confirmText: '알겠어요', cancelText: '닫기',
    });
    return false;
  }
  if (!changes.length && !p.incomplete) return true;
  const kept = changes.some((l) => l.includes('따로 보관'));
  return confirmDialog({
    title: (opts && opts.versionNo ? opts.versionNo + '판으로 되돌려 공개하면' : '공개하면') + ' 표가 이렇게 바뀌어요',
    message: p.incomplete ? '다 보지는 못했어요 — ' + p.incomplete : undefined,
    lines: changes,
    note: '공개하면 다른 사람도 모두 이 판을 써요.' + (kept ? ' 지운 값은 따로 보관돼요(앱에서는 더 안 보여요).' : ''),
    confirmText: '공개하기',
    danger: changes.some((l) => l.includes('지우기')),
  });
}
