// chat-diff.ts — 도구 원문이 **변경분(diff)인지** 가려 줄마다 갈래를 붙인다(#2055). DOM 을 모른다(순수).
//
//  ── 왜 떼어냈나 ──
//  파일을 고치는 도구의 결과는 대개 통합 diff 다(codex 의 fileChange, `git diff`, 패치 도구). 그걸 회색 pre 한 장으로
//  두면 무엇이 들어오고 무엇이 나갔는지 사람이 +/- 를 눈으로 세야 한다 — 이 화면에서 가장 자주 펼쳐 보는 원문인데도.
//  판정과 세기는 **틀려도 화면이 멀쩡해 보이는** 종류라(그럴듯한 초록/빨강이 칠해질 뿐이다) 문자열 계약으로 못박는다.
//  그리는 일은 chat-view.ts 가 한다 — 여기는 전역을 잡지 않아 테스트가 그대로 부를 수 있다(chat-tool-group.ts 와 같은 결).
//
//  ── 계약 ──
//  · diff 로 **인정하는 조건**: `@@ ` 또는 `diff --git ` 머리가 있고, +/- 로 시작하는 줄이 한 줄이라도 있다.
//    둘 중 하나만으로는 아니다 — 마크다운 목록(`- 항목`)이나 로그가 통째로 초록/빨강이 되는 것을 막는다.
//  · `--- a/x` · `+++ b/x` 는 **세지 않는다**(그건 파일 이름줄이지 바뀐 줄이 아니다).
//  · 모르는 줄은 갈래 없이 그대로 둔다 — 지어내지 않는다.

export type DiffKind = '' | 'add' | 'del' | 'hunk' | 'meta';
export interface DiffLine { kind: DiffKind; text: string }
export interface DiffScan {
  /** 이 원문을 변경분으로 그릴까. false 면 나머지 필드는 비어 있다. */
  isDiff: boolean;
  add: number;
  del: number;
  lines: DiffLine[];
}

/** 파일 이름·모드·유사도 같은 **머리줄** — `+++`/`---` 로 시작해도 바뀐 줄이 아니다. */
const META = /^(diff --git |index [0-9a-f]{6,}|--- |\+\+\+ |new file mode |deleted file mode |old mode |new mode |similarity index |rename (from|to) |Binary files )/;

export function isDiffText(s: string): boolean {
  const text = String(s ?? '');
  if (!text) return false;
  const head = text.split('\n', 400);
  if (!head.some((l) => l.startsWith('@@ ') || l.startsWith('diff --git '))) return false;
  return head.some((l) => (l.startsWith('+') || l.startsWith('-')) && !META.test(l));
}

export function scanDiff(s: string): DiffScan {
  const text = String(s ?? '');
  if (!isDiffText(text)) return { isDiff: false, add: 0, del: 0, lines: [] };
  const lines: DiffLine[] = [];
  let add = 0; let del = 0;
  for (const text0 of text.split('\n')) {
    const kind: DiffKind = text0.startsWith('@@') ? 'hunk'
      : META.test(text0) ? 'meta'
      : text0.startsWith('+') ? 'add'
      : text0.startsWith('-') ? 'del' : '';
    if (kind === 'add') add++; else if (kind === 'del') del++;
    lines.push({ kind, text: text0 });
  }
  return { isDiff: true, add, del, lines };
}
