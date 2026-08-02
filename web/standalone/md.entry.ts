// public/md.js 번들 엔트리(#1313 R51) — terminal.html 이 클래식 <script> 로 직접 읽는 산출물의 입구.
//  손편집 시절 md.js 는 클래식 스크립트라 최상위 function 선언이 그대로 **전역**이었다(el·renderMarkdown …).
//  TS 모듈 + iife 번들로 옮기면 그 전역 노출이 사라지므로, 종전 계약을 여기서 명시적으로 복원한다
//  (지금의 유일한 소비자인 terminal.ts 는 import 로 쓰지만, 전역 표면 자체를 없애면 동작 동일성이 깨진다).
import { el, safeHref, mdImage, renderInline, mdParseContainerAttrs, mdRenderContainer, renderMarkdown } from './md.js';

Object.assign(window as any, { el, safeHref, mdImage, renderInline, mdParseContainerAttrs, mdRenderContainer, renderMarkdown });
