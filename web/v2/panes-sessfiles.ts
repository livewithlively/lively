// web/v2/panes-sessfiles.ts — 곁칸 «세션 파일» 부품 (#4088 후속, 2026-09-23)
//  지금 보는 세션의 **작업 폴더**를 보여 준다. 프로젝트 없는 세션(loose)엔 자료 칸이 없어서, 세션이 만든 파일에
//  닿을 길이 폰에도 데스크톱에도 없었다(원준: "터미널 세션에서 자료를 바로 보러가고 다운받거나 뷰어 할 수 있는게 … 잘 안됨").
//  탐색기 자체는 우패널·팝아웃이 쓰던 것(web/v2/files.ts)을 그대로 세우고, 파일을 누르면 이 칸 안 미리보기 대신
//  **뷰어 칸**으로 보낸다(자료 칸과 같은 길 — 폰에선 서랍 안의 서랍이 되지 않는다).
//  ⚠ 부품은 «이 프로젝트의 것»이 아니라 «지금 보는 세션의 것»(panes-parts PartCtx 주석) — 세션이 바뀌면 그 폴더로 갈아 세운다.
import { el } from '../core.js';
import { createSessionFiles, type FilesHandle } from './files.js';
import { openInViewerPart, pnIcon } from './panes-kit.js';
import type { Part, PartCtx } from './panes-parts.js';

export function sessFilesPart(ctx: PartCtx): Part {
  const root = el('div', { class: 'pn-part pn-sessfiles' });
  let cur: { sid: string; h: FilesHandle } | null = null;
  const empty = el('div', { class: 'pn-empty' },
    pnIcon('folder', 'pn-i big'),
    el('b', { text: '아직 보고 있는 세션이 없어요.' }),
    el('p', { class: 'pn-fine', text: '세션을 하나 열면 그 세션의 작업 폴더가 여기 보여요.' }));
  //  노드 세션은 `node=` 를 실어야 그 노드의 파일이다(files.ts nodeQ) — 목록 행의 node 는 이미 id 문자열이다(views.ts mergeSessions).
  const nodeOf = (sid: string): string | null => {
    const r = ctx.data().sessions.find((x) => x.id === sid);
    return r && r.node ? String(r.node) : null;
  };
  function paint(): void {
    const sid = ctx.curSession();
    if (cur && cur.sid === sid) return;                 // 같은 세션 — 8초 틱마다 다시 세우면 보던 폴더가 튄다
    if (cur) { cur.h.destroy(); cur = null; }
    root.replaceChildren();
    if (!sid) { root.append(empty); return; }
    const node = nodeOf(sid);
    const h = createSessionFiles(root, {
      sessionId: sid, node,
      onOpenFile: (rel) => { openInViewerPart(ctx, rel, { sid, node }); return true; },
    });
    cur = { sid, h };
  }
  const off = ctx.onSession(() => paint());
  paint();
  return { root, tick: () => paint(), destroy: () => { off(); if (cur) { cur.h.destroy(); cur = null; } } };
}
