// projects/detail-hub-body.ts — 허브 «본문» 위젯(#4135, 5판 시안 2026-09-25 원준: «읽기가 첫째. 편집은 「편집」을 눌러야 시작된다.
//  본문은 사용자가 쓴 마크다운 그대로 — 위젯이 절을 정하지 않는다. 크기가 커지면 코멘트를 같이 보인다»).
//   1×1  본문(스크롤) · 바닥 코멘트 N(새 M) [편집][열기]
//   1×2  «갱신 N» + [편집] 줄 · 본문                       1×3+  + 코멘트 둘 · 글쓰기
//   2×1  본문 두 단                                      3×1  본문 두 단 + 코멘트 칸(250)
//   2×2+ 본문 + 코멘트 칸(220 · 글쓰기)                   3×2+ 본문 + 코멘트 칸(250 · 글쓰기)
//  편집 = 블록 에디터(detail-body.mountBodyEditor, 항시 자동저장)를 그 자리에 앉힌다. 문장에 붙는 코멘트(시안 3×2 여백 메모)는 서버에
//  문장 좌표가 없어 아직 못 한다 — 코멘트 칸으로 대신한다(후속).
import { api, el, personFace, relTime, renderMarkdown, toast } from '../core.js';
import { type Fill, btn, footText, hubIcon, stripMd } from './detail-hub-kit.js';
import { bodyCharCount, unreadComments } from './detail-hub-model.js';

const readKey = (pid: number) => 'pjv_cmt_read_' + pid;
const lastRead = (pid: number): number => { try { return Number(localStorage.getItem(readKey(pid))) || 0; } catch (_) { return 0; } };
const markRead = (pid: number, comments: any[]): void => { try { const mx = Math.max(0, ...comments.map((c) => Number(c.id) || 0)); if (mx) localStorage.setItem(readKey(pid), String(mx)); } catch (_) { /* */ } };
// 편집 중 상태 — 격자를 다시 그려도(다른 위젯의 설정 변경) 편집이 안 날아가게 프로젝트별로 기억한다.
const EDITING = new Set<number>();

export const fillBody: Fill = (ctx, f, body, foot, sub, acts) => {
  const { o, P, pid } = ctx;
  const w = f.w, h = f.h;
  const md = String(P.description || '');
  const open = () => ctx.openTool('body');
  sub.textContent = P.updated_at ? '갱신 ' + relTime(P.updated_at) : '';

  // ── 본문(읽기) — 사용자의 마크다운 그대로. 넓으면 두 단. ──
  const twoCol = h <= 1 && w >= 2;
  const readBox = (): HTMLElement => {
    const r = el('div', { class: 'pjh-read' + (twoCol ? ' cols2' : '') });
    if (md.trim()) r.append(renderMarkdown(md));
    else r.append(el('div', { class: 'pjh-stat', style: 'padding:4px 2px', text: '본문이 비어 있습니다 — 편집을 눌러 적으세요.' }));
    return r;
  };
  let editor: { el: HTMLElement; flush: () => Promise<void>; destroy: () => void } | null = null;
  const editBtn = el('button', { class: 'pjh-sbtn ghost', type: 'button' }, hubIcon('pen', 12), '편집');
  const textHost = el('div', { class: 'pjh-body-col' });
  const contentHost = el('div', { class: 'pjh-body-content' });
  const paintText = () => {
    contentHost.replaceChildren();   // «갱신 · 편집» 줄(bh)은 남기고 본문만 바꾼다
    if (EDITING.has(pid) && o.bodyEditor) {
      editor = o.bodyEditor();
      contentHost.append(el('div', { class: 'pjh-edit-host' }, editor.el));
      editBtn.replaceChildren(hubIcon('check', 12), '완료');
    } else {
      editor = null;
      contentHost.append(readBox());
      editBtn.replaceChildren(hubIcon('pen', 12), '편집');
    }
  };
  editBtn.onclick = async (e) => {
    e.stopPropagation();
    if (!o.bodyEditor) { open(); return; }
    if (EDITING.has(pid)) { EDITING.delete(pid); if (editor) { try { await editor.flush(); } catch (_) { /* */ } editor.destroy(); } paintText(); }
    else { EDITING.add(pid); paintText(); const ed = textHost.querySelector('[contenteditable]') as HTMLElement | null; if (ed) ed.focus(); }
  };
  // «갱신 · 편집» 줄 — 1×1 은 바닥 단추가 그 역할(자리가 없다)
  const bh = (h >= 2 || w >= 2) ? el('div', { class: 'pjh-bh' }, el('span', { text: P.updated_at ? '갱신 ' + relTime(P.updated_at) : '' }), editBtn) : null;
  if (bh) textHost.append(bh);
  textHost.append(contentHost);
  paintText();

  // ── 코멘트 칸 ──
  const withCol = (h <= 1 && w >= 3) || (h >= 2 && w >= 2);
  const withInline = w <= 1 && h >= 3;
  const cmtHost = el('div', { class: 'pjh-cmt-col' });
  const cnt = el('span', { class: 'pjh-wf-txt' }, hubIcon('comment', 13), '코멘트');
  const cmtCard = (c: any, compact = false): HTMLElement => el('div', { class: 'pjh-cm' + (compact ? ' compact' : '') },
    personFace(c.actor, 'pjv-ava', c.display_name || ctx.memberName(c.actor)),
    el('div', { class: 'pjh-cm-b' },
      el('div', { class: 'pjh-cm-h' }, el('b', { text: c.display_name || ctx.memberName(c.actor) || '' }), el('span', { text: c.ts ? relTime(c.ts) : '' })),
      el('div', { class: 'pjh-cm-t', text: stripMd(c.body || '') })));
  const composer = (): HTMLElement => {
    const ta = el('textarea', { class: 'pjh-composer-in', rows: '1', placeholder: '코멘트 남기기…' }) as HTMLTextAreaElement;
    const send = el('button', { class: 'pjh-sbtn', type: 'button', title: '보내기 (⌘Enter)' }, hubIcon('send', 12));
    const go = async () => {
      const text = ta.value.trim(); if (!text) return;
      send.disabled = true; ta.disabled = true;
      try { await api('/api/ui/v6/tasks/' + pid + '/comments', { method: 'POST', body: JSON.stringify({ text }) }); ta.value = ''; ctx.D.invalidate('comments'); ctx.refreshGrid(); }
      catch (err: any) { toast('전송 실패 — ' + (err && err.message || err), true); send.disabled = false; ta.disabled = false; }
    };
    send.onclick = go;
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); go(); } });
    ta.addEventListener('input', () => { ta.rows = Math.min(4, Math.max(1, ta.value.split('\n').length)); });
    return el('div', { class: 'pjh-composer' }, ta, send);
  };

  if (withCol) body.append(el('div', { class: 'pjh-two-b', style: 'grid-template-columns:minmax(0,1fr) ' + (w >= 3 ? 250 : 220) + 'px' }, textHost, cmtHost));
  else { body.append(textHost); if (withInline) body.append(cmtHost); }

  ctx.D.comments().then((cs: any[]) => {
    const unread = unreadComments(cs, lastRead(pid), ctx.meId);
    cnt.append(' ' + cs.length);
    if (unread) cnt.append(el('span', { class: 'pjh-pill new', text: '새 ' + unread }));
    if (!withCol && !withInline) return;
    const newest = cs.slice().reverse();
    cmtHost.append(el('div', { class: 'pjh-cmt-h' }, hubIcon('comment', 13), el('b', { text: '코멘트 ' + cs.length }), unread ? el('span', { text: '· 새 ' + unread }) : null));
    const list = el('div', { class: 'pjh-cmt-list' });
    const n = withInline ? 2 : (h <= 1 ? 2 : h * 3);
    for (const c of newest.slice(0, n)) list.append(cmtCard(c, withInline));
    if (!cs.length) list.append(el('div', { class: 'pjh-stat', text: '아직 코멘트가 없어요.' }));
    cmtHost.append(list);
    if (h >= 2) cmtHost.append(composer());
    markRead(pid, cs);   // 칸에 보였으면 읽은 것 — 섹션 배지와 같은 표식(pjv_cmt_read_<pid>)
  });

  // ── 바닥 ──
  if (w <= 1 && h <= 1) foot.append(cnt, editBtn, btn('열기', 'btn-ghost', open));
  else if (withCol || withInline) foot.append(footText('본문 ' + bodyCharCount(md).toLocaleString() + '자'), btn(w >= 2 && h >= 2 ? '전폭으로' : '열기', 'btn-ghost', open));
  else foot.append(cnt, btn('열기', 'btn-ghost', open));
  void acts;
};
