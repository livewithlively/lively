// globals.d.ts — ambient declarations for browser globals provided OUTSIDE the module graph.
// 컴파일만 통과시키기 위한 선언(동작 변경 없음, .d.ts 라 .js 산출물 없음).

// xterm.js + addon-fit 는 index.html 의 CDN <script> 가 window 전역으로 주입한다(모듈 import 아님).
declare const Terminal: any;
declare const FitAddon: any;

// window.Terminal / window.FitAddon 접근(renderTerminalSession)도 통과시킨다.
interface Window {
  Terminal: any;
  FitAddon: any;
}
