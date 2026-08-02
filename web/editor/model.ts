// editor/model.ts — 블록 데이터 모델의 공용 상수(#1313 R58 — block-editor.ts 에서 verbatim 적출).
//
// ── 블록 데이터 모델 ──
//  { type, text?, level?, indent?, checked?, lang?, icon?, color? } — text 는 inline-markdown(개행 = 소프트 브레이크).
//  #657n 중첩 블록(노션 패리티): toggle { summary, children:[블록…] } · columns { cols:[[블록…],…] }
//  — notion-md ::: 방언(:::toggle / :::columns>:::column)으로 무손실 직렬화, 파스 실패는 raw 폴백.
export const TEXTY = new Set(['p', 'h', 'bullet', 'numbered', 'todo', 'quote', 'callout', 'toggle']);
export const LISTY = new Set(['bullet', 'numbered', 'todo']);
export const CALLOUT_COLORS = ['default', 'gray', 'yellow', 'green', 'red', 'purple'];
