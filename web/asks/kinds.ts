// asks/kinds.ts — 세션 요청 카드 종류 목록(#5713). **새 종류는 여기 한 줄**(+ 서버 쪽 src/asks/kinds/index.ts 한 줄).
//  불러오는 것만으로 등록된다(각 파일 끝의 registerAskKind) — 카드를 그리는 자리(곁칸 «요청» 칸 · 요청 화면)가 이 파일을 import 한다.
import './kind-secret.js';
import './kind-choice.js';
import './kind-upload.js';
