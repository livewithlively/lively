// v2/publish-preview.ts — 「공개하기」 전에 «이번 공개가 표에 무엇을 하는지» 보여 주고 확인을 받는다(#4732).
//
//  공개한 앱의 초안은 표를 더하는 일만 저장 때 하고, 칸 지우기 · 이름 · 종류 바꾸기 · 조이기는 공개할 때 한다(#4724). 그 목록이 지금까지는
//  저장한 사람의 저장 응답에만 왔다 — 책임자 · 관리자가 남의 초안을 공개할 때나 나중에 화면에서 공개할 때는 볼 길이 없었다.
//  서버(app_publish_preview)가 실제 공개와 같은 표 맞추기를 걸어 보고 되돌려 계산한다. 여기는 그 결과를 확인 창으로 보여 줄 뿐이다.
//   · 표에 할 일이 없으면 묻지 않는다(true — 지금처럼 바로 공개). «알아 둘 것»(notes)만 있을 때도 묻지 않는다 — 늘 뜨는 창은 넘기게 된다.
//   · 이대로면 공개가 멈추면(빈 행 · 겹친 값 · 가리킬 행 없음) 그 까닭을 보여 주고 false.
//   · 미리 보기가 서버 고장 · 연결 문제로 안 되면 그래도 공개할지 묻는다 — 공개는 어긋나면 아무것도 바꾸지 않고 멈추므로 안전하다.
//     권한 · 없는 앱(4xx)이면 공개도 같은 까닭으로 안 되니 묻지 않고 알린다.
import { api, toast } from '../core.js';
import { confirmDialog } from '../ui-primitives.js';
import { josa, verJ } from '../lib/studio-flow.js';   // #4632 판 번호는 버전 이름으로(초안 · V2 …)

interface PublishPreview {
  changes?: string[]; notes?: string[]; blocked?: string[]; incomplete?: string | null;
  tables?: { dropped_columns?: Array<{ rows?: number }> } | null; gone_tables?: Array<{ action?: string; rows?: number }>;
}

//  하나씩만 — 미리 보기가 서버에서 잠금을 기다리는 동안 다시 누르면 확인 창이 둘 겹치고, 둘 다 누르면 공개가 두 번 나간다.
let busy = false;

/** versionNo — 그 판으로 되돌리고 바로 공개할 때(앱빌더 「이 판으로」). 돌려주는 값 = 공개해도 되나. */
export async function confirmPublish(appId: string, opts?: { versionNo?: number; title?: string }): Promise<boolean> {
  if (busy) return false;
  busy = true;
  try { return await ask(appId, opts); } finally { busy = false; }
}

async function ask(appId: string, opts?: { versionNo?: number; title?: string }): Promise<boolean> {
  const name = opts && opts.title ? '「' + opts.title + '」' : '이 앱';
  let p: PublishPreview;
  //  보통 1초 안쪽이다 — 길어지면(다른 사람이 그 표를 쓰는 중) 말없이 멈춰 있지 않게 알린다.
  const slow = window.setTimeout(() => toast('공개하면 표에 무엇을 하는지 확인하는 중…'), 600);
  try {
    p = await api('/api/ui/apps/' + encodeURIComponent(appId) + '/publish-preview', {
      method: 'POST', body: JSON.stringify(opts && opts.versionNo ? { version_no: opts.versionNo } : {}),
    }) as PublishPreview;
  } catch (e: any) {
    const st = Number(e && e.status);
    if (st >= 400 && st < 500 && st !== 408 && st !== 429) { toast('공개할 수 없어요. ' + (e && e.message ? e.message : e), true); return false; }
    return confirmDialog({
      title: '표에 할 일을 확인하지 못했어요', message: e && e.message ? e.message : String(e),
      note: '그래도 공개할 수 있어요. 공개하다가 데이터가 새 규칙에 맞지 않으면 아무것도 바뀌지 않고 멈춰요.', confirmText: '그래도 공개하기',
    });
  } finally { window.clearTimeout(slow); }
  const changes = Array.isArray(p.changes) ? p.changes : [];
  const notes = Array.isArray(p.notes) ? p.notes : [];
  const blocked = Array.isArray(p.blocked) ? p.blocked : [];
  if (blocked.length) {
    await confirmDialog({
      title: '이대로는 공개할 수 없어요',
      message: josa(name, '을') + ' 이대로 공개하면 멈춰요. 아래를 고친 뒤 다시 공개해 주세요. 지금은 아무것도 바뀌지 않았어요.',
      lines: blocked, confirmText: '알겠어요', cancelText: '닫기',
    });
    return false;
  }
  if (!changes.length && !p.incomplete) return true;
  //  값이 사라지는 일(칸 · 표 지우기)이 있으면 빨간 단추 · 보관 안내 — 줄 글이 아니라 보고서 칸으로 가른다(문구를 다듬어도 깨지지 않게).
  const dropped = (p.tables && Array.isArray(p.tables.dropped_columns)) ? p.tables.dropped_columns : [];
  const gone = Array.isArray(p.gone_tables) ? p.gone_tables : [];
  const kept = dropped.some((d) => Number(d && d.rows) > 0) || gone.some((g) => g && g.action === 'archive');
  const what = opts && opts.versionNo ? verJ(opts.versionNo, '으로') + ' 되돌려 공개하면' : '공개하면';
  return confirmDialog({
    title: changes.length ? what + ' 표가 이렇게 바뀌어요' : '표에 할 일을 다 보지 못했어요',
    message: p.incomplete ? (changes.length ? '다 보지는 못했어요. ' : '') + p.incomplete : undefined,
    lines: [...changes, ...notes.map((n) => '참고: ' + n)],
    note: '공개하면 다른 사람도 모두 이 버전을 써요.' + (kept ? ' 지운 값은 따로 보관돼요(앱에서는 더 안 보여요).' : '')
      + (p.incomplete ? ' 공개하다가 데이터가 새 규칙에 맞지 않으면 아무것도 바뀌지 않고 멈춰요.' : ''),
    confirmText: changes.length ? '공개하기' : '그래도 공개하기',
    danger: dropped.length > 0 || gone.length > 0,
  });
}
