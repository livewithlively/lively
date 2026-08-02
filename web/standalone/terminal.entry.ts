// public/terminal.js 번들 엔트리(#1313 R51) — 손편집 시절 파일의 마지막 줄 `boot();` 이 있던 자리.
//  부팅 호출을 엔트리로 분리해, 모듈 자체는 import 만으로 부팅되지 않는다(테스트가 판정 함수를 직접 import).
import { boot } from './terminal.js';

boot();
