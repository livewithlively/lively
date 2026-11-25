// asks/kind-upload.ts — 세션 요청 ▸ 파일 올리기 카드(#1631 → #5713). 서버 짝: src/asks/kinds/upload.ts.
//  종전엔 리브 카드(web/liv-cards.ts livUploadCard)였다. 달라진 것 하나: 올리면 요청이 닫히고, 무엇이 올라갔는지(이름 · 자료 id)가 AI 에게 간다.
import { api, el } from '../core.js';
import type { Ask } from './api.js';
import { registerAskKind, type AskCtx } from './registry.js';

interface UploadPayload { label?: string; why?: string; accept_hint?: string }

/**
 * 파일 올리기 — **로컬 폴더를 뒤지는 대신 끌어다 놓는다**(대표 판단).
 *
 * 글자 파일만 받는다. PDF·이미지는 브라우저에서 글자를 못 뽑아 **올린 척만 하고 빈 자료가 쌓이므로**,
 * 되는 척하지 않고 그 자리에서 거른다.
 */
function uploadCard(req: Ask, ctx: AskCtx): HTMLElement {
  const ask = req.payload as UploadPayload;
  const TEXT_RE = /\.(md|markdown|txt|csv|tsv|json|ya?ml|log|rtf|html?|tex|org)$/i;
  const msg = el('div', { class: 'liv-ask-msg' });
  const input = el('input', { class: 'liv-upload-in', type: 'file', multiple: 'multiple' }) as HTMLInputElement;

  //  올라간 것은 여기 쌓는다 — AI 에게 알리기(submit)가 실패해 다시 시도할 때 같은 파일을 또 올리지 않게(자료가 두 벌이 된다).
  const saved: Array<{ name: string; source_id?: number }> = [];
  let failedN = 0, skippedN = 0;
  const retry = el('button', { class: 'btn btn-sm btn-primary', type: 'button', text: 'AI 에게 다시 알리기', hidden: true }) as HTMLButtonElement;

  const tell = async (): Promise<void> => {
    retry.hidden = true; input.disabled = true;
    try { await ctx.submit({ files: saved, failed: failedN, skipped: skippedN }); }
    catch (e) {
      input.disabled = false; retry.hidden = false;
      msg.replaceChildren(el('span', { class: 'liv-ask-err', text: `파일 ${saved.length}개는 올라갔는데 AI 에게 알리지 못했어요 — ${(e as Error)?.message ?? e}` }));
    }
  };
  retry.onclick = () => void tell();

  input.onchange = async (): Promise<void> => {
    const files = [...(input.files ?? [])];
    if (!files.length) return;
    const ok = files.filter((f) => TEXT_RE.test(f.name));
    const skipped = files.filter((f) => !TEXT_RE.test(f.name));
    input.disabled = true;
    const failed: string[] = [];
    let savedNow = 0;
    for (const f of ok) {
      try {
        const body_md = await f.text();
        if (!body_md.trim()) { failed.push(`${f.name}(비어 있음)`); continue; }
        const r: any = await api('/api/ui/sources', { method: 'POST', body: JSON.stringify({
          kind: 'upload', title: f.name, body_md,
          occurred_at: new Date(f.lastModified).toISOString(),
        }) });
        const sid = Number(r?.source?.id);
        saved.push({ name: f.name, ...(Number.isInteger(sid) && sid > 0 ? { source_id: sid } : {}) });
        savedNow++;
      } catch (e) { failed.push(`${f.name}(${(e as Error)?.message ?? e})`); }
    }
    input.value = '';
    failedN += failed.length; skippedN += skipped.length;
    const parts = [`${savedNow}개 올렸습니다`];
    if (skipped.length) parts.push(`${skipped.length}개는 글자 파일이 아니라 건너뛰었습니다`);
    if (failed.length) parts.push(`${failed.length}개 실패`);
    msg.replaceChildren(el('span', { class: failed.length ? 'liv-ask-err' : 'liv-ask-ok', text: parts.join(' · ') }));
    //  하나도 못 올렸으면 요청을 닫지 않는다 — 사람이 다른 파일로 다시 올린다.
    if (!saved.length) { input.disabled = false; return; }
    //  못 올린 것이 있으면 몇 개인지도 AI 에게 간다(카드는 곧 사라져 위 글을 사람이 못 볼 수 있다).
    await tell();
  };

  return el('div', { class: 'liv-ask' },
    el('div', { class: 'liv-ask-head' }, el('b', { text: ask.label ?? '파일 올리기' })),
    ask.why ? el('div', { class: 'liv-ask-why', text: ask.why }) : null,
    el('div', { class: 'liv-ask-row' }, input),
    el('div', { class: 'liv-ask-row liv-ask-acts' }, ctx.later(), retry),
    el('div', { class: 'liv-ask-note', text: ask.accept_hint || '글자로 된 파일만 됩니다 — 메모·문서(.txt·.md)·표(.csv) 등. PDF·이미지는 아직 안 됩니다.' }),
    msg);
}

registerAskKind('upload', { render: uploadCard });
