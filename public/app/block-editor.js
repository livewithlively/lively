// block-editor.ts — #657 노션형 블록 에디터(WYSIWYG). 지식 본문(markdown)을 블록 단위로 직접 편집한다.
//  · 저장 포맷은 그대로 markdown(body_md) — 에이전트/MCP/기존 렌더러와 완전 호환(파스↔직렬화 왕복).
//  · 지원 블록: 문단·제목1-3·글머리/번호/할일 목록(들여쓰기)·인용·콜아웃·코드·구분선·이미지(인라인).
//    표·토글·수식 등 에디터가 구조적으로 못 다루는 마크다운은 'raw 블록'(렌더 미리보기 + 원문 편집)으로 무손실 보존.
//  · 입력 UX: '/' 슬래시 메뉴, 마크다운 단축(#·-·1.·[]·>·```·---), 선택 시 인라인 서식 툴바(굵게/기울임/…/링크),
//    ⋮⋮ 드래그 재정렬, ＋ 블록 추가, Enter 분할·Backspace 병합, Tab 들여쓰기. 한국어 IME 조합 가드(#505 동형).
//  · 보안 불변식 유지: innerHTML 금지 — 모든 DOM 은 el/renderInline/renderMarkdown(전부 textContent 기반)로만.
//  순환 import 금지: core/learn/page-decor 만 import (knowledge-doc/knowledge-edit/category-home 이 이 모듈을 쓴다).
//
// #1313 R58 — 2,200줄 단일 파일을 web/editor/ 로 분해했다. 이 파일은 **조립 + 배럴 재수출**만 한다(소비자 import 무수정):
//   editor/model.ts      블록 데이터 모델 상수(TEXTY·LISTY·CALLOUT_COLORS)
//   editor/parse.ts      markdown → 블록  (순수)  ┐ 왕복 계약을 scripts/block-editor-roundtrip.test.mjs 가 고정
//   editor/serialize.ts  블록 → markdown  (순수)  ┘
//   editor/caret.ts      캐럿/선택 헬퍼(document 전역만 의존)
//   editor/context.ts    조립 계약 — 옛 클로저의 자유변수를 승격한 ctx/상태 타입(왜 이 모양인지 그 파일에 적어 뒀다)
//   editor/render.ts     블록 DOM 생성 + 카드/컬렉션/raw 미리보기
//   editor/blocks.ts     블록 접근/데이터 추출 + 구조 연산(변환·삽입·삭제·재번호·정규화)
//   editor/slash.ts      '/' 슬래시 메뉴(SLASH_ITEMS 단일 소유)
//   editor/mention.ts    '[[' 페이지 멘션
//   editor/insert.ts     이미지/파일/링크/인라인 마크 삽입 헬퍼
//   editor/toolbar.ts    인라인 서식 툴바 + 링크 팝오버 + 블록 전환 드롭다운
//   editor/keys.ts       keydown/input(마크다운 단축·IME 가드)
//   editor/interactions.ts 체크박스·클릭·붙여넣기·드롭·⋮⋮ 메뉴·드래그(컬럼 생성)
//   editor/history.ts    #657z 마크다운 스냅샷 실행취소
import { el } from './core.js';
import { mdToBlocks } from './editor/parse.js';
import { blocksToMd, inlineDomToMd } from './editor/serialize.js';
import { createRender } from './editor/render.js';
import { createBlocks } from './editor/blocks.js';
import { createMention } from './editor/mention.js';
import { createInsert } from './editor/insert.js';
import { createSlash } from './editor/slash.js';
import { createToolbar } from './editor/toolbar.js';
import { createHistory } from './editor/history.js';
import { createKeys } from './editor/keys.js';
import { createInteractions } from './editor/interactions.js';
// ════════════════════════════════════════════
// 에디터 조립
// ════════════════════════════════════════════
export function createBlockEditor(opts = {}) {
    const root = el('div', { class: 'be', 'data-ph': opts.placeholder || "내용을 입력하세요. '/' 를 누르면 블록 메뉴가 열립니다." });
    // #657z 실행취소 — 브라우저 네이티브 undo 는 구조 변경(드래그·전환·삭제·컬럼…)을 모른다 →
    //  에디터가 마크다운 스냅샷 스택을 직접 소유(⌘Z/⌘⇧Z·Ctrl+Y). 타이핑은 유휴 600ms 로 묶고,
    //  구조 연산은 setTimeout(0) 코얼레싱으로 '한 연산 = 한 스텝'(복합 연산도 동기 프레임 끝 상태 1장).
    const st = { dirty: false, composing: false, histLock: false, slash: null, mention: null };
    const ctx = { opts, root, st };
    ctx.markDirty = () => { st.dirty = true; if (!st.histLock)
        ctx.snapSoon(); if (opts.onChange)
        opts.onChange(); }; // 구조 변경 — 즉시 스냅샷(프레임 단위 코얼레싱)
    ctx.markDirtyType = () => { st.dirty = true; if (!st.histLock)
        ctx.snapLater(); if (opts.onChange)
        opts.onChange(); }; // 타이핑 — 유휴 600ms 버스트 단위
    // 모듈 간 호출은 전부 ctx 경유(늦은 바인딩)라 순서 자유지만, **값**을 별칭으로 받는 두 곳만 순서가 있다:
    //  createToolbar·createInteractions 는 ctx.SLASH_ITEMS(배열)를 읽으므로 createSlash 뒤여야 한다.
    //  createToolbar 는 호출 즉시 document.body 에 툴바를 붙이고 selectionchange 를 구독한다(해제는 destroy).
    Object.assign(ctx, createRender(ctx));
    Object.assign(ctx, createBlocks(ctx));
    Object.assign(ctx, createMention(ctx));
    Object.assign(ctx, createInsert(ctx));
    Object.assign(ctx, createSlash(ctx));
    Object.assign(ctx, createToolbar(ctx));
    Object.assign(ctx, createHistory(ctx));
    createKeys(ctx); // keydown/input 리스너 등록(반환값 없음)
    Object.assign(ctx, createInteractions(ctx)); // 포인터/드래그 리스너 등록 + 크로스 블록 선택 API(bsel*)
    const { blockEls, blockData, ensureOne, renumber, focusBlock, isEmptyNow, makeBlock, closeSlashMenu, closeMention, snapNow, resetHistory } = ctx;
    // ── 로드/공개 API ──
    function load(md) {
        closeSlashMenu();
        root.replaceChildren(...mdToBlocks(md || '').map(makeBlock));
        ensureOne();
        renumber();
    }
    load(opts.initial || '');
    resetHistory();
    return {
        el: root,
        getMarkdown: () => blocksToMd(blockEls().map(blockData)),
        setMarkdown: (md) => {
            // 사용자가 이미 만지던 에디터라면(히스토리 2스텝↑ 또는 미저장 편집) 교체를 undo 가능한 1스텝으로 남긴다 — 대문 템플릿 적용 등.
            const live = ctx.histLen() > 1 || st.dirty;
            if (live)
                snapNow();
            load(md);
            if (live)
                snapNow();
            else
                resetHistory();
            st.dirty = false;
        },
        isDirty: () => st.dirty,
        resetDirty: () => { st.dirty = false; },
        isEmpty: () => isEmptyNow(),
        focusEnd: () => { const bs = blockEls(); if (bs.length)
            focusBlock(bs[bs.length - 1], false); },
        destroy: () => {
            ctx.clearHistoryTimers();
            document.removeEventListener('selectionchange', ctx.onSelChange);
            ctx.tools.remove();
            closeSlashMenu();
            closeMention();
            for (const sel of ['.be-blockmenu', '.be-turnpop', '.be-linkpop']) {
                const n = document.querySelector(sel);
                if (n)
                    n.remove();
            }
        },
    };
}
export { mdToBlocks, blocksToMd, inlineDomToMd };
