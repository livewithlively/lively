// editor/context.ts — 에디터 인스턴스 조립 계약(#1313 R58).
//
// block-editor.ts 는 원래 1,800줄짜리 **단일 클로저**였다(모든 헬퍼가 root/opts/dirty/slash… 를 자유변수로 공유).
// 클로저는 ESM 파일 경계로 쪼갤 수 없으므로, 그 자유변수 집합을 이 컨텍스트 객체로 승격했다:
//  · createBlockEditor 가 빈 ctx 를 만들어 각 모듈 팩토리에 넘기고, 팩토리가 돌려준 함수들을 ctx 에 채운다.
//  · 모듈끼리는 **서로를 import 하지 않는다** — 상호 호출은 전부 ctx 경유(런타임 순환 0, 타입만 이 파일에 의존).
//  · 각 모듈 상단의 `const foo = (…) => ctx.foo(…)` 별칭은 **늦은 바인딩** 장치다. 덕분에 옮겨온 본문은
//    한 글자도 고치지 않아도 되고(verbatim), 팩토리 호출 순서에도 (값이 아닌 한) 자유롭다.
//
// ⚠ 가변 상태는 EditorState 에 모은다 — ESM import 바인딩은 재할당이 불가하고, 모듈 밖에서 `dirty = true`
//   같은 대입을 하려면 객체 필드여야 한다. 필드마다 '소유 모듈'을 적어 둔다(그 모듈만 쓰고 나머지는 읽는다).
export interface BlockEditorOpts {
  initial?: string;
  placeholder?: string;
  onChange?: () => void;
  onSaveShortcut?: () => void;
  // 파일 업로드 콜백(#730) — 이미지 붙여넣기·드롭·슬래시 업로드·첨부에 사용. 저장 후 서빙 URL(또는 실패 null) 반환.
  //  넘기지 않으면(지식 문서 등) 업로드형 명령은 숨고, 이미지는 URL 삽입만 가능.
  uploadFile?: (file: File) => Promise<string | null>;
}

export interface EditorState {
  dirty: boolean;      // 소유: block-editor.ts(markDirty/공개 API) — history 도 undo 뒤 세운다
  composing: boolean;  // 소유: keys.ts(compositionstart/end) — history/slash 가 읽는다(#505 IME 가드)
  histLock: boolean;   // 소유: history.ts(applyHistory 중 재진입 차단)
  slash: any;          // 소유: slash.ts — { block, anchorNode, anchorOffset, menu, items, sel, typed }
  mention: any;        // 소유: mention.ts — { block, node, from, query, menu, items, sel, timer }
}

export interface EditorCtx {
  opts: BlockEditorOpts;
  root: HTMLElement;
  st: EditorState;
  markDirty(): void;
  markDirtyType(): void;

  // ── render.ts ──
  makeBlock(d: any): HTMLElement;
  collAttrsOf(block: HTMLElement): any;
  promptPageCard(block: HTMLElement): void;
  openRawEditor(block: HTMLElement, wrap: HTMLElement): void;

  // ── blocks.ts ──
  blockEls(): HTMLElement[];
  blockOf(node: any): HTMLElement | null;
  textElOf(block: HTMLElement): HTMLElement | null;
  prevTextBlock(block: HTMLElement): any;
  nextTextBlock(block: HTMLElement): any;
  blockData(block: HTMLElement): any;
  renumber(): void;
  normalizeStructure(): void;
  duplicateBlock(block: HTMLElement): void;
  moveBlockDir(block: HTMLElement, dir: number): void;
  deleteBlock(block: HTMLElement): void;
  ensureOne(): void;
  isEmptyNow(): boolean;
  focusBlock(block: HTMLElement, atStart?: boolean): void;
  convertBlock(block: HTMLElement, to: any): HTMLElement;
  insertBlockAfter(block: HTMLElement | null, data: any): HTMLElement;
  toToggleBlock(b: HTMLElement, summaryText: string): HTMLElement;

  // ── slash.ts ──
  SLASH_ITEMS: any[];
  openSlashMenu(block: HTMLElement, typed: boolean): void;
  closeSlashMenu(): void;
  applySlash(item: any): void;
  paintSlash(): void;
  syncSlashQuery(): void;

  // ── mention.ts ──
  closeMention(): void;
  paintMention(): void;
  applyMention(it: any): void;
  syncMention(target: HTMLElement): void;

  // ── insert.ts ──
  promptImage(block: HTMLElement): void;
  beToday(): string;
  insertMdBlock(block: HTMLElement, md: string): HTMLElement;
  insertUploadedImages(block: HTMLElement, files: File[]): Promise<void>;
  pickAndUploadFile(block: HTMLElement, asImage: boolean): void;
  insertLinkAtBlock(block: HTMLElement, bookmark: boolean): void;
  wrapOrInsertInline(tag: string): void;

  // ── toolbar.ts ──
  tools: HTMLElement;
  toggleWrap(tag: string): void;
  openLinkPop(): void;
  onSelChange(): void;

  // ── history.ts ──
  snapNow(): void;
  snapSoon(): void;
  snapLater(): void;
  histFlushTyping(): void;
  resetHistory(): void;
  histUndo(): void;
  histRedo(): void;
  histLen(): number;
  clearHistoryTimers(): void;
}
