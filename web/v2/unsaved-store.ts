// v2/unsaved-store.ts — 저장하지 못한 글의 보관소(lib/unsaved-text)를 이 기기·이 워크스페이스의 저장소에 묶는다(#4084).
//  쓰는 자리가 둘이라(곁칸 태스크의 [본문]·[규칙] 접이 · 프로젝트 상세의 본문) 열쇠를 한 곳에서 선언한다 — 두 파일이
//  각자 적으면 한쪽만 워크스페이스 접미사가 붙는 사고가 난다(workspace-local-state-isolation E7 과 같은 이유).
import { deviceStore } from './shell-prefs.js';
import { dropUnsaved, peekUnsaved, stashUnsaved } from '../lib/unsaved-text.js';

const UNSAVED_KEY = deviceStore('lively_v2_unsaved_text');   // 글의 내용이 든다 — 워크스페이스마다 갈린다
export type UnsavedSlot = 'body' | 'rules';
const idOf = (projectId: number, slot: UnsavedSlot): string => `p${projectId}:${slot}`;

export const keepUnsaved = (projectId: number, slot: UnsavedSlot, text: string): boolean => stashUnsaved(localStorage, UNSAVED_KEY, idOf(projectId, slot), text);
export const readUnsaved = (projectId: number, slot: UnsavedSlot): string | null => { try { return peekUnsaved(localStorage, UNSAVED_KEY, idOf(projectId, slot)); } catch (_) { return null; } };
export const clearUnsaved = (projectId: number, slot: UnsavedSlot): void => { try { dropUnsaved(localStorage, UNSAVED_KEY, idOf(projectId, slot)); } catch (_) { /* noop */ } };
