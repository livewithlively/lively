/* app.lvly.io 개인 모드 프로토타입 — 화면·흐름 시뮬레이션 (백엔드 없음)
   라우트: #/start 진입 · #/welcome 온보딩 룸 · #/home · #/library · #/work · #/liv · #/board(팀 모드)
   상태는 sessionStorage 에 남겨 새로고침해도 이어진다. 프로토타입 메뉴(우하단)로 언제든 되감는다. */
(function () {
  'use strict';
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ic = (n, cls) => `<svg class="ic ${cls || ''}" aria-hidden="true"><use href="#i-${n}"/></svg>`;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const nowStr = () => { const d = new Date(); return `${d.getHours() < 12 ? '오전' : '오후'} ${((d.getHours() + 11) % 12) + 1}:${String(d.getMinutes()).padStart(2, '0')}`; };
  const KO = { day: ['일', '월', '화', '수', '목', '금', '토'] };
  const dateStr = () => { const d = new Date(); return `${d.getMonth() + 1}월 ${d.getDate()}일 ${KO.day[d.getDay()]}요일`; };

  /* ───────────────────────── 데이터 ───────────────────────── */
  const ROLES = ['기획·PO', '마케팅', '연구·대학원', '법무·계약', '개발', '운영·재무', '1인 사업', '학생'];
  const SOURCES = [
    { id: 'gdrive', label: '구글 드라이브', live: true, logo: 'D' }, { id: 'notion', label: '노션', live: true, logo: 'N' },
    { id: 'slack', label: '슬랙', live: true, logo: 'S' }, { id: 'gmail', label: '지메일', live: true, logo: 'M' },
    { id: 'clickup', label: '클릭업', live: true, logo: 'C' }, { id: 'folder', label: '내 컴퓨터 폴더', live: false, logo: '📁' },
    { id: 'git', label: '깃 저장소', live: false, logo: 'G' }, { id: 'none', label: '딱히 없어요 — 대화로 시작', live: false, logo: '·', none: true },
  ];
  // 선택지는 코어 하네스 카탈로그(src/terminal/catalog.ts)의 제공자와 맞춘다 — Claude Code(Anthropic)·
  //  Codex(OpenAI)·Antigravity(Google)·Grok Build(xAI)·OpenCode(그 밖). 사람에게는 CLI 이름 대신 아는 이름으로 묻는다.
  const AIS = ['Claude', 'ChatGPT', 'Gemini', 'Grok', '여러 개', '아직 없어요'];

  /* ═════ 페르소나 — 직업 8종 전수(폴백 없음) ═════
     Q1 직업 → Q2 세부 → Q3 그 세부의 업무 → Q4 리브의 진단(맞혀보기) → 자료에서 병목 3개.
     세부(detail)마다 업무 목록이 실제로 갈라진다 — 이게 없으면 무엇을 골라도 같은 질문이 나온다. */
  const PERSONA = {
    '기획·PO': {
      detail: { q: '어떤 제품을 맡고 계세요?', opts: [['b2b', 'B2B SaaS'], ['app', '앱·서비스'], ['new', '신사업·기획'], ['proj', '수탁·프로젝트']] },
      jobs: {
        b2b: ['스펙 쓰기', '고객 요구 정리', '릴리스 노트', '로드맵 갱신', '경쟁사 보기', '지표 확인'],
        app: ['화면 기획', '사용자 피드백 정리', 'A/B 결과 보기', '릴리스 노트', '앱 리뷰 훑기', '지표 확인'],
        new: ['시장 조사', '사업계획 초안', '가설 검증 정리', '경쟁사 보기', '투자·보고 자료', '회의 정리'],
        proj: ['제안서 쓰기', '요구사항 정리', '진척 보고', '고객 회의록', '산출물 검수', '일정 관리'],
      },
      guess: { line: (d) => `${d} 하시면 보통 <b>스펙이 버전별로 흩어져서</b>, 지금 확정본이 뭔지 확인하는 데 시간을 쓰십니다.`, alt: ['아니요 — 고객 요구가 정리가 안 돼요', '아니요 — 회의 결정이 안 남아요'] },
      files: ['스펙_결제개편_v3.docx', 'VOC 정리 8월.xlsx', '로드맵 Q3.pptx', '8/12 팀 회의.m4a', '경쟁사 비교표.xlsx', '릴리스 노트 7월.md', '2024_최종_진짜최종.pptx', '무제 문서(3).docx'],
      tally: [['스펙·기획서', 18], ['VOC·리서치', 13], ['회의록', 10]],
      firstq: ['결제 개편 스펙에서 아직 안 정한 것만 골라 줘', '8월 VOC에서 반복된 요구 3개 뽑아 줘', '8/12 회의에서 내가 하기로 한 일이 뭐였지?'],
      answers: [
        { html: `미결 <b>3건</b>입니다.<br>· 부분 환불 정책 — 담당 미정<br>· 해외 카드 대응 범위<br>· 마이그레이션 기간 중 병행 운영 여부`, ev: [['스펙_결제개편_v3', '근거']], read: '읽은 것 1건 · 8초', ladder: ['미결마다 결정 옵션을 표로 만들어 줘'] },
        { html: `8월 VOC 34건에서 <b>3가지</b>가 반복됩니다.<br>· 결제 실패 안내가 불친절 (9건)<br>· 팀 초대가 어렵다 (7건)<br>· 리포트 내보내기 필요 (5건)`, ev: [['VOC 정리 8월', '근거']], read: '읽은 것 1건 · 9초', ladder: ['이 3개를 스펙 항목으로 바꿔 줘'] },
        { html: `세 가지예요.<br>1. 결제 스펙 미결 3건 정리 — 금요일까지<br>2. 로드맵 Q3 공유<br>3. 릴리스 노트 초안`, ev: [['8/12 팀 회의', '근거']], read: '읽은 것 1건 · 7초', ladder: ['할 일 3개를 목록으로 만들어 줘'] },
      ],
      sugs: [['스펙', '결제 개편 스펙 미결 항목만 표로 만들어 줘'], ['VOC', '8월 VOC에서 반복된 요구 뽑아 줘'], ['회의', '이번 주 회의에서 결정만 모아 줘']],
      bottle: [
        { t: '스펙이 버전별로 흩어져 있어요', ev: '스펙_결제개편 v1·v2·v3 세 벌', fix: '확정본을 v3로 고정하고, 답할 때 항상 그 기준으로', slip: '최신 기준 고정 · 스펙 v3' },
        { t: 'VOC가 스펙과 이어져 있지 않아요', ev: 'VOC 34건이 엑셀에만 있음', fix: '요구가 어느 스펙 항목으로 갔는지 연결해 두기', slip: 'VOC ↔ 스펙 연결 규칙' },
        { t: '회의는 녹음하는데 결정이 안 남아요', ev: '8/12 회의 녹음만 있고 결정 문서 없음', fix: '회의록 들어오면 결정·할 일만 자동으로 뽑기', slip: '자동: 회의록 → 결정·할 일' },
      ],
      map: { tidy: [['스펙은 제품별로 묶어 줘', '결제·온보딩 스펙이 갈래로 나뉘어요'], ['VOC는 월별로 정리해 줘', '8월·7월 순서로 나란히']], auto: [['새 스펙 올라오면 미결 항목 뽑아 줘', 'TBD·미정이 표시돼 진행 중인 일에 올라와요'], ['매주 월요일에 지난주 결정 모아 줘', '월요일 8시에 정리됩니다']], watch: [['스펙이 새 버전으로 바뀌면 알려 줘', '확정본이 바뀌면 리브가 먼저 말을 걸어요'], ['VOC에 같은 요구가 3번 넘게 나오면 알려 줘', '반복 요구를 리브가 세어 둡니다']] },
      wiki: [
        { t: '결제 개편 스펙 — 미결 3건', kind: '종합', src: ['스펙_결제개편_v3.docx'], when: '어제', body: '· 부분 환불 정책 — 담당 미정\n· 해외 카드 대응 범위\n· 마이그레이션 기간 중 병행 운영 여부' },
        { t: '8월 VOC — 반복 요구 3가지', kind: '종합', src: ['VOC 정리 8월.xlsx'], when: '어제', body: '· 결제 실패 안내 불친절 9건\n· 팀 초대 어려움 7건\n· 리포트 내보내기 5건' },
        { t: '자료 갈래 — 스펙·VOC·회의록', kind: '정리 규칙', src: ['자료 41건'], when: '처음 설정 때', body: '스펙·기획서 18 · VOC·리서치 13 · 회의록 10. 스펙은 제품별, VOC는 월별로 둡니다.' },
      ],
    },
    '마케팅': {
      detail: { q: '어느 쪽 마케팅에 가까우세요?', opts: [['b2c', 'B2C 브랜드'], ['b2b', 'B2B 리드'], ['com', '커머스'], ['con', '콘텐츠·SNS']] },
      jobs: {
        b2c: ['캠페인 회고', '콘텐츠 초안', '성과 리포트', '소재 기획', '고객 후기 정리', '회의 정리'],
        b2b: ['리드 리포트', '세일즈 자료', '웨비나 준비', '콘텐츠 초안', '고객 사례 정리', '회의 정리'],
        com: ['상세페이지 문구', '프로모션 기획', '매출·성과 리포트', '리뷰 정리', '재고·가격 확인', '회의 정리'],
        con: ['콘텐츠 초안', '발행 일정 관리', '성과 리포트', '소재 아카이브', '댓글·반응 정리', '회의 정리'],
      },
      guess: { line: (d) => `${d} 하시면 보통 <b>같은 보고서를 매달 새로 쓰느라</b> 시간을 쓰십니다.`, alt: ['아니요 — 자료가 어디 있는지 찾는 게 더 오래 걸려요', '아니요 — 회의 결정이 안 남아요'] },
      files: ['8/12 팀 회의.m4a', '7월 월간 보고서.pptx', '가격 정책 v3.docx', '가격 정책(7월).docx', '8월 캠페인 기획서.docx', '캠페인 성과 시트.xlsx', '2024_최종_진짜최종.pptx', '무제 문서(3).docx'],
      tally: [['캠페인·콘텐츠', 17], ['성과 리포트', 12], ['회의록', 12]],
      firstq: ['8/12 회의에서 내가 하기로 한 일이 뭐였지?', '가격 정책이 어떻게 바뀌어 왔지?', '7월 보고서를 세 줄로 요약해 줘'],
      answers: [
        { html: `세 가지예요.<br>1. 공지 초안 — 금요일까지<br>2. 디자인 시안 검토 요청<br>3. 환불 기준 문서 갱신(v3)`, ev: [['8/12 회의록', '근거'], ['환불 기준 v3', '근거']], read: '읽은 것 2건 · 12초', ladder: ['공지 초안까지 써 줘', '할 일 3개를 목록으로 만들어 줘'] },
        { html: `세 번 바뀌었어요.<br>7/30 v1 — 7일 이내 · 8/5 v2 — 10일로 연장 논의 · 8/12 v3 — <b>14일 확정</b>(9월 1일 시행)`, ev: [['회의록 3건', '근거'], ['가격 정책 v3', '근거']], read: '읽은 것 4건 · 15초', ladder: ['바뀐 이유를 한 줄씩 붙여 줘', '고객 안내문 초안 써 줘'] },
        { html: `7월 보고서 요약입니다.<br>· 매출 전월 대비 +8% — 후기 영상 유입이 절반<br>· 이탈 원인 1위는 환불 절차 불만<br>· 8월 과제: 환불 안내 개편 · 후기 소재 확대`, ev: [['7월 월간 보고서', '근거']], read: '읽은 것 1건 · 9초', ladder: ['같은 양식으로 8월 초안 잡아 줘'] },
      ],
      sugs: [['회의 정리', '이번 주 회의 3건에서 결정만 모아 줘'], ['보고서', '7월 보고서 양식으로 8월 초안 써 줘'], ['새 자료', '드라이브에 새로 들어온 파일 요약해 줘']],
      bottle: [
        { t: '월간 보고서를 매달 처음부터 쓰고 계세요', ev: '6월·7월 보고서가 같은 양식', fix: '같은 양식으로 8월 초안을 미리 만들어 두기', slip: '자동: 월간 보고서 초안' },
        { t: '가격 정책이 두 벌이라 매번 확인이 필요해요', ev: '가격 정책 v3 · 가격 정책(7월)', fix: '최신 기준을 하나로 정하고 그 기준으로만 답하기', slip: '최신 기준 고정 · 가격 정책' },
        { t: '회의는 녹음하는데 결정이 안 남아요', ev: '8/12 회의 녹음만 있음', fix: '회의록 들어오면 결정·할 일만 자동으로 뽑기', slip: '자동: 회의록 → 결정·할 일' },
      ],
      map: { tidy: [['캠페인 자료는 캠페인 이름별로 묶어 줘', '기획서·성과 시트가 한 갈래로 모여요'], ['보고서는 월별로 정리해 줘', '7월부터 월 순서로 나란히']], auto: [['매주 월요일 아침에 지난주 회의 결정 모아 줘', '월요일 8시, 결정·할 일이 올라와요'], ['월간 보고서 올라오면 세 줄 요약 만들어 둬', '새 보고서마다 요약이 먼저 생겨요']], watch: [['가격 정책 문서가 또 바뀌면 먼저 알려 줘', '새 버전이 들어오면 리브가 먼저'], ['같은 자료가 두 벌 있으면 알려 줘', '겹치는 문서를 잡아냅니다']] },
      wiki: [
        { t: '가격 정책 — 최신 기준은 7월 문서', kind: '규칙', src: ['가격 정책 v3.docx', '가격 정책(7월).docx'], when: '처음 설정 때', body: '두 문서 중 7월 문서를 최신으로 봅니다. 답할 때는 7월 문서 기준으로 말합니다.\n\n· 환불 기간: 결제일 기준 14일 (9/1 시행)\n· 종전: 7일 (8월 결제분까지)' },
        { t: '8/12 팀 회의 — 결정 3건 · 할 일 3건', kind: '회의 요약', src: ['8/12 팀 회의.m4a'], when: '어제', body: '결정\n1. 환불 기간 14일로 확정 (9/1 시행)\n2. 후기 영상 소재 확대\n3. 디자인 시안은 금요일까지 검토\n\n할 일\n☐ 공지 초안 — 금요일까지\n☐ 디자인 시안 검토 요청\n☐ 환불 기준 문서 갱신' },
        { t: '자료 갈래 — 캠페인·리포트·회의록', kind: '정리 규칙', src: ['자료 41건'], when: '처음 설정 때', body: '캠페인·콘텐츠 17 · 성과 리포트 12 · 회의록 12. 회의록은 결정·할 일만 남기고 잡담은 접어 둡니다.' },
      ],
    },
    '연구·대학원': {
      detail: { q: '지금 어느 단계세요?', opts: [['ug', '학부 연구생'], ['ms', '석사'], ['phd', '박사과정'], ['post', '포닥·연구원']] },
      jobs: {
        ug: ['논문 읽기', '실험 보조', '세미나 준비', '데이터 정리', '수업 과제', '미팅 준비'],
        ms: ['논문 읽기', '실험·분석', '학위논문 초안', '미팅 준비', '세미나 발표', '코드·데이터 정리'],
        phd: ['논문 쓰기', '리뷰 대응', '실험 설계', '후배 지도', '학회 준비', '연구비 서류'],
        post: ['논문 쓰기', '과제 제안서', '공동연구 조율', '학회 준비', '데이터 관리', '미팅 준비'],
      },
      guess: { line: (d) => `${d}시면 보통 <b>읽은 논문과 내 메모가 이어지지 않아서</b>, 쓸 때 다시 찾느라 시간을 쓰십니다.`, alt: ['아니요 — 실험 결과 버전 관리가 더 문제예요', '아니요 — 지도교수 피드백 반영을 놓쳐요'] },
      files: ['Kim et al. 2025.pdf', '학위논문 2장 초안.docx', '3월 미팅 노트.md', '실험 결과 v4.xlsx', '지도교수 피드백.pdf', '관련연구 정리.docx', 'Lee 2024.pdf', '무제 문서(3).docx'],
      tally: [['논문', 23], ['노트·메모', 12], ['회의록', 6]],
      firstq: ['내가 읽은 논문 중에 이 주장을 반박하는 게 있었나?', '3월 미팅에서 교수님이 지적한 게 뭐였지?', '실험 결과 v4에서 달라진 것만 정리해 줘'],
      answers: [
        { html: `논문 2편이 반대 결과를 보고합니다.<br>· Kim 외 (2025) 4장 — "표본을 넓히면 효과가 사라졌다."<br>· Lee (2024) 결론 — "같은 조건에서 재현되지 않았다."<br>3월에 남긴 메모와 어긋나는 지점 1곳을 표시했습니다.`, ev: [['읽은 논문 23편', '근거'], ['내 메모', '근거']], read: '읽은 것 23건 · 18초', ladder: ['이 반박까지 넣어서 관련 연구 절 다시 써 줘'] },
        { html: `두 가지를 지적하셨어요.<br>· 표본 크기 근거 보강 — "n=40으로는 약하다"<br>· 관련 연구에 Lee (2024) 누락`, ev: [['3월 미팅 노트', '근거']], read: '읽은 것 1건 · 8초', ladder: ['지적을 반영한 2장 수정 목록 만들어 줘'] },
        { html: `v3와 비교해 달라진 것 3가지입니다.<br>· 조건 B 정확도 71 → 78%<br>· 표본 40 → 120<br>· 그림 3 교체`, ev: [['실험 결과 v4', '근거']], read: '읽은 것 2건 · 9초', ladder: ['달라진 이유를 한 줄씩 붙여 줘'] },
      ],
      sugs: [['논문', '이번 주 읽은 논문 3편 핵심만 표로 정리해 줘'], ['초안', '관련 연구 절을 반박 논문까지 넣어 다시 써 줘'], ['미팅', '다음 미팅 전에 정리해 둘 질문 뽑아 줘']],
      bottle: [
        { t: '읽은 논문과 내 메모가 따로 놀아요', ev: '논문 23편 · 메모 12건이 서로 연결 없음', fix: '논문마다 내 메모·인용 위치를 이어 두기', slip: '논문 ↔ 메모 연결 규칙' },
        { t: '실험 결과 버전이 쌓여 있어요', ev: '실험 결과 v3 · v4', fix: '최신본을 고정하고 달라진 것만 따로 남기기', slip: '최신 기준 고정 · 실험 결과 v4' },
        { t: '지도교수 지적이 반영됐는지 추적이 안 돼요', ev: '3월 미팅 노트의 지적 2건', fix: '지적사항을 체크리스트로 만들어 반영 여부 표시', slip: '피드백 체크리스트' },
      ],
      map: { tidy: [['논문은 주제별로 묶어 줘', 'Kim·Lee 등이 주제 갈래로 나뉘어요'], ['미팅 노트는 지도교수 코멘트만 남겨 줘', '코멘트만 추려 접어 둬요']], auto: [['새 논문 넣으면 한 문단 요약 만들어 둬', 'PDF마다 요약이 먼저 생겨요'], ['매주 금요일에 이번 주 읽은 논문 정리해 줘', '한 주 읽은 것의 목록과 요지']], watch: [['내 메모와 어긋나는 논문 결과가 있으면 알려 줘', '반대 결과 논문을 리브가 먼저 짚어요'], ['같은 논문을 두 번 넣으면 알려 줘', '중복 PDF를 잡아냅니다']] },
      wiki: [
        { t: '관련 연구 — 반대 결과 논문 2편', kind: '종합', src: ['Kim et al. 2025.pdf', 'Lee 2024.pdf'], when: '어제', body: '· Kim 외 (2025) 4장 — 표본을 넓히면 효과가 사라짐\n· Lee (2024) 결론 — 같은 조건에서 재현되지 않음\n\n2장 초안의 주장과 어긋나는 지점 1곳을 표시해 두었습니다.' },
        { t: '3월 미팅 — 지도교수 지적 2건', kind: '회의 요약', src: ['3월 미팅 노트.md'], when: '처음 설정 때', body: '· 표본 크기 근거 보강 — "n=40으로는 약하다"\n· 관련 연구에 Lee (2024) 누락' },
        { t: '자료 갈래 — 논문 · 노트 · 회의록', kind: '정리 규칙', src: ['자료 41건'], when: '처음 설정 때', body: '논문 23 · 노트·메모 12 · 회의록 6. 논문은 주제별, 노트는 날짜순으로 둡니다.' },
      ],
    },
    '법무·계약': {
      detail: { q: '어디에서 일하고 계세요?', opts: [['in', '사내 법무'], ['firm', '로펌'], ['rev', '계약 검토 전담'], ['comp', '규제·컴플라이언스']] },
      jobs: {
        in: ['계약서 검토', '표준 문구 대조', '사내 자문', '리스크 정리', '품의·결재', '회의 정리'],
        firm: ['계약서 작성', '의견서 쓰기', '판례 조사', '고객 회신', '기일 관리', '회의 정리'],
        rev: ['계약서 검토', '표준 문구 대조', '검토 의견서', '수정안 회신', '이력 관리', '회의 정리'],
        comp: ['규정 검토', '내부 점검', '교육 자료', '리스크 보고', '감사 대응', '회의 정리'],
      },
      guess: { line: (d) => `${d} 하시면 보통 <b>표준과 다른 조항을 매번 손으로 찾느라</b> 시간을 쓰십니다.`, alt: ['아니요 — 지난 검토 이력을 찾는 게 더 오래 걸려요', '아니요 — 회의 결정이 안 남아요'] },
      files: ['표준 계약서 v4.docx', '검토 요청 계약서(18쪽).pdf', '지난 검토 메모.docx', '8/12 팀 회의.m4a', '위약금 조항 정리.xlsx', '판례 노트.md', '2024_최종_진짜최종.pptx', '무제 문서(3).docx'],
      tally: [['계약서', 19], ['검토 메모', 14], ['회의록', 8]],
      firstq: ['검토 요청 계약서에서 표준 계약서 v4와 다른 조항만 찾아 줘', '지난 검토 메모에서 반복된 이슈가 뭐였지?', '8/12 회의에서 내가 하기로 한 일이 뭐였지?'],
      answers: [
        { html: `표준 계약서 v4와 대조해 <b>3곳</b>이 다릅니다.<br>· 7조 위약금 — 대금의 20% <b>(표준은 10%)</b><br>· 12조 관할 — 상대방 소재지 법원 <b>(표준은 서울중앙지법)</b><br>· 9조 비밀유지 — 기간 없음 <b>(표준은 3년)</b>`, ev: [['표준 계약서 v4', '근거'], ['검토 요청 계약서', '근거']], read: '읽은 것 2건 · 14초', ladder: ['조항마다 수정 문구 달아 줘', '검토 의견서 초안 써 줘'] },
        { html: `지난 검토 메모 14건에서 <b>반복된 이슈 2개</b>가 보입니다.<br>· 위약금 상한 — 5건에서 같은 지적<br>· 관할 합의 누락 — 4건`, ev: [['지난 검토 메모', '근거']], read: '읽은 것 14건 · 11초', ladder: ['이 두 이슈를 체크리스트로 만들어 줘'] },
        { html: `세 가지예요.<br>1. 검토 의견서 초안 — 금요일까지<br>2. 표준 계약서 v5 초안 배포<br>3. 판례 노트 갱신`, ev: [['8/12 회의록', '근거']], read: '읽은 것 1건 · 7초', ladder: ['할 일 3개를 목록으로 만들어 줘'] },
      ],
      sugs: [['대조', '새 계약서 초안을 표준과 대조해 줘'], ['문구', '다른 조항마다 수정 문구 달아 줘'], ['회의', '이번 주 회의 3건에서 결정만 모아 줘']],
      bottle: [
        { t: '표준과 다른 조항을 매번 손으로 찾고 계세요', ev: '계약서 19건 · 표준 계약서 v4', fix: '새 계약서가 들어오면 표준과 자동 대조해 두기', slip: '자동: 새 계약서 → 표준 대조' },
        { t: '검토 이력이 계약서와 이어져 있지 않아요', ev: '검토 메모 14건이 따로 있음', fix: '계약서마다 그 검토 이력을 한 줄로 붙이기', slip: '계약서 ↔ 검토 메모 연결' },
        { t: '같은 지적이 반복되고 있어요', ev: '위약금 상한 5건 · 관할 누락 4건', fix: '반복 이슈를 체크리스트로 만들어 먼저 확인', slip: '반복 이슈 체크리스트' },
      ],
      map: { tidy: [['검토 메모를 계약서별로 묶어 줘', '계약서마다 검토 이력이 한 줄로 따라붙어요'], ['같은 계약의 버전은 한 줄로 모아 줘', '흩어진 판을 하나로']], auto: [['새 계약서 올라오면 표준 계약서 v4와 대조해 둬', '다른 조항만 표시해 진행 중인 일에 올려 둬요'], ['매주 월요일에 지난주 검토 메모 요약해 줘', '한 주 검토의 반복 이슈가 정리돼요']], watch: [['표준 문구와 다른 조항이 보이면 먼저 말해 줘', '위약금 20%·관할 변경 같은 게 보이면 리브가 먼저'], ['만료 30일 전 계약이 있으면 알려 줘', '기간 조항을 보고 미리 말을 걸어요']] },
      wiki: [
        { t: '표준 계약서 v4 — 대조 기준 조항 6개', kind: '규칙', src: ['표준 계약서 v4.docx'], when: '처음 설정 때', body: '· 7조 위약금 — 대금의 10%\n· 9조 비밀유지 — 3년\n· 12조 관할 — 서울중앙지법\n· 4조 대금 지급 — 검수 후 30일\n· 6조 지연손해 — 연 6%\n· 15조 해지 — 30일 전 서면' },
        { t: '검토 메모 14건에서 반복된 이슈 2개', kind: '종합', src: ['지난 검토 메모.docx', '위약금 조항 정리.xlsx'], when: '어제', body: '· 위약금 상한 — 5건에서 같은 지적(표준 10% 초과)\n· 관할 합의 누락 — 4건\n\n다음 검토부터 이 둘은 먼저 확인합니다.' },
        { t: '자료 갈래 — 계약서 · 검토 메모 · 회의록', kind: '정리 규칙', src: ['자료 41건'], when: '처음 설정 때', body: '계약서 19 · 검토 메모 14 · 회의록 8. 계약서는 상대방·체결일 기준으로 묶습니다.' },
      ],
    },
    '개발': {
      detail: { q: '어느 쪽을 주로 하세요?', opts: [['be', '백엔드'], ['fe', '프론트엔드'], ['full', '풀스택·1인'], ['infra', '인프라·데브옵스']] },
      jobs: {
        be: ['API 설계', '코드 리뷰', '장애 대응', '기술 문서', '스펙 확인', '릴리스 노트'],
        fe: ['화면 구현', '코드 리뷰', 'UI 버그 대응', '디자인 확인', '기술 문서', '릴리스 노트'],
        full: ['기능 구현', '배포·운영', '고객 문의 대응', '기술 문서', '스펙 정리', '릴리스 노트'],
        infra: ['배포 파이프라인', '장애 대응', '비용 점검', '보안 점검', '런북 정리', '온콜 인수인계'],
      },
      guess: { line: (d) => `${d} 하시면 보통 <b>회고에서 정한 액션이 추적되지 않아서</b>, 같은 문제가 다시 옵니다.`, alt: ['아니요 — 스펙 미결이 더 문제예요', '아니요 — 릴리스 노트 쓰는 게 반복이라 귀찮아요'] },
      files: ['README.md', 'API v2 마이그레이션 스펙.md', '8/12 팀 회의.m4a', '릴리스 노트 7월.md', '장애 회고 0805.md', '온보딩 문서.docx', 'AGENTS.md', 'CLAUDE.md'],
      tally: [['기술 문서', 22], ['회의록', 12], ['회고·릴리스', 7]],
      firstq: ['장애 회고 0805에서 남은 액션이 뭐였지?', 'API v2 스펙에서 아직 안 정한 것만 골라 줘', '8/12 회의에서 내가 하기로 한 일이 뭐였지?'],
      answers: [
        { html: `남은 액션 3개입니다.<br>· 재시도 큐 상한 설정 — 담당 나<br>· 알림 중복 제거<br>· 회고 문서 팀 공유`, ev: [['장애 회고 0805', '근거']], read: '읽은 것 1건 · 8초', ladder: ['이 3개를 할 일 목록으로 만들어 줘'] },
        { html: `아직 안 정한 것 2건입니다.<br>· 인증 토큰 만료 처리 방식<br>· v1 호환 유지 기간`, ev: [['API v2 마이그레이션 스펙', '근거']], read: '읽은 것 1건 · 7초', ladder: ['미결마다 결정 옵션을 표로 정리해 줘'] },
        { html: `세 가지예요.<br>1. API v2 미결 2건 정리<br>2. 재시도 큐 상한 설정<br>3. 릴리스 노트 8월 초안`, ev: [['8/12 회의록', '근거']], read: '읽은 것 1건 · 7초', ladder: ['할 일 3개를 목록으로 만들어 줘'] },
      ],
      sugs: [['회고', '이번 주 장애 회고에서 액션만 모아 줘'], ['스펙', 'API v2 스펙 미결 항목을 표로 만들어 줘'], ['릴리스', '7월 릴리스 노트 양식으로 8월 초안 써 줘']],
      bottle: [
        { t: '회고 액션이 문서에만 있고 추적이 안 돼요', ev: '장애 회고 0805의 액션 3건', fix: '회고가 올라오면 액션을 할 일로 꺼내 두기', slip: '자동: 회고 → 액션 추출' },
        { t: '스펙에 미결이 남은 채 진행되고 있어요', ev: 'API v2 스펙의 TBD 2건', fix: '스펙에 TBD가 남아 있으면 먼저 알려 주기', slip: '점검: 스펙 미결 감시' },
        { t: '릴리스 노트를 매번 손으로 쓰고 계세요', ev: '릴리스 노트 7월 · 6월 같은 양식', fix: '릴리스마다 변경 요약을 먼저 만들어 두기', slip: '자동: 릴리스 노트 초안' },
      ],
      map: { tidy: [['회고·릴리스 노트는 버전별로 묶어 줘', '버전 축으로 정리돼요'], ['README와 온보딩 문서는 한 갈래로 둬', '새 팀원이 볼 문서가 한 곳에']], auto: [['릴리스 노트 올라오면 변경 요약 만들어 둬', '릴리스마다 요약이 먼저 생겨요'], ['매주 월요일에 지난주 장애·결정 모아 줘', '회고의 액션 아이템이 올라와요']], watch: [['스펙 문서에 미결 항목이 남아 있으면 알려 줘', 'TBD를 리브가 먼저 짚어요'], ['회고의 액션이 2주 넘게 안 닫히면 알려 줘', '액션을 추적합니다']] },
      wiki: [
        { t: '장애 회고 0805 — 남은 액션 3개', kind: '회의 요약', src: ['장애 회고 0805.md'], when: '어제', body: '· 재시도 큐 상한 설정 — 담당 나\n· 알림 중복 제거\n· 회고 문서 팀 공유' },
        { t: 'API v2 마이그레이션 — 미결 2건', kind: '종합', src: ['API v2 마이그레이션 스펙.md'], when: '어제', body: '· 인증 토큰 만료 처리 방식\n· v1 호환 유지 기간' },
        { t: '자료 갈래 — 기술 문서 · 회의록 · 회고', kind: '정리 규칙', src: ['자료 41건'], when: '처음 설정 때', body: '기술 문서 22 · 회의록 12 · 회고·릴리스 7. 회고·릴리스는 버전 축으로 정렬합니다.' },
      ],
    },
    '운영·재무': {
      detail: { q: '어느 업무에 가까우세요?', opts: [['set', '정산·결산'], ['fin', '재무 기획'], ['ga', '총무·오피스'], ['hr', '인사 운영']] },
      jobs: {
        set: ['월 정산', '증빙 대사', '결산 보고', '세금계산서 확인', '지출 정리', '회의 정리'],
        fin: ['예산 관리', '자금 계획', '실적 분석', '보고 자료', '투자·대출 서류', '회의 정리'],
        ga: ['비품·계약 관리', '지출 품의', '사무실 운영', '업체 응대', '규정 정리', '회의 정리'],
        hr: ['입퇴사 처리', '급여 확인', '근태 관리', '규정 안내', '채용 일정', '회의 정리'],
      },
      guess: { line: (d) => `${d} 하시면 보통 <b>매달 같은 양식을 새로 채우느라</b> 시간을 쓰십니다.`, alt: ['아니요 — 증빙을 찾아 맞추는 게 더 오래 걸려요', '아니요 — 지난 기준을 확인하는 게 문제예요'] },
      files: ['8월 정산.xlsx', '7월 결산 보고.xlsx', '지출 증빙 8월.pdf', '법인카드 내역.xlsx', '8/12 팀 회의.m4a', '품의서 양식.docx', '2024_최종_진짜최종.pptx', '무제 문서(3).docx'],
      tally: [['정산·결산', 21], ['증빙·전표', 13], ['회의록', 7]],
      firstq: ['8월 정산에서 지난달과 다른 항목만 골라 줘', '법인카드 내역 중 증빙이 없는 건 뭐야?', '7월 결산 보고 양식으로 8월 초안 써 줘'],
      answers: [
        { html: `지난달과 다른 항목 <b>4건</b>입니다.<br>· 광고비 +180만원 (신규 캠페인)<br>· 소프트웨어 구독 2건 신규<br>· 출장비 0원 (지난달 320만원)<br>· 임차료 계약 갱신으로 +5%`, ev: [['8월 정산', '근거'], ['7월 결산 보고', '근거']], read: '읽은 것 2건 · 11초', ladder: ['차이 원인을 한 줄씩 붙여 줘'] },
        { html: `증빙이 안 붙은 건 <b>3건</b>입니다.<br>· 8/03 소프트웨어 구독 · 12만원<br>· 8/11 식대 · 8만원<br>· 8/19 택시 · 3.2만원`, ev: [['법인카드 내역', '근거'], ['지출 증빙 8월', '근거']], read: '읽은 것 2건 · 13초', ladder: ['담당자별로 나눠서 요청 문구 만들어 줘'] },
        { html: `7월 양식 그대로 8월 초안을 만들었습니다.<br>· 매출·비용 표는 8월 정산에서 채웠고<br>· 전월 대비 증감란은 계산해 두었습니다<br>· 코멘트란 3곳은 비워 두었어요`, ev: [['7월 결산 보고', '근거'], ['8월 정산', '근거']], read: '읽은 것 2건 · 15초', ladder: ['코멘트란도 초안 채워 줘'] },
      ],
      sugs: [['정산', '8월 정산에서 지난달과 다른 항목만 골라 줘'], ['증빙', '증빙 없는 카드 내역 찾아 줘'], ['보고', '7월 결산 양식으로 8월 초안 써 줘']],
      bottle: [
        { t: '매달 같은 결산 양식을 새로 채우고 계세요', ev: '6월·7월 결산 보고가 같은 양식', fix: '정산이 마감되면 같은 양식으로 초안 만들어 두기', slip: '자동: 결산 보고 초안' },
        { t: '카드 내역과 증빙이 대사되지 않아요', ev: '법인카드 내역 · 지출 증빙 8월이 따로', fix: '내역과 증빙을 맞춰 보고 빠진 것만 알려 주기', slip: '자동: 증빙 대사' },
        { t: '지난 기준을 매번 다시 확인하고 계세요', ev: '품의서 양식 · 규정 문서가 흩어짐', fix: '기준 문서를 하나로 고정하고 그 기준으로 답하기', slip: '최신 기준 고정 · 품의 규정' },
      ],
      map: { tidy: [['정산 자료는 월별로 묶어 줘', '8월·7월 순서로 나란히'], ['증빙은 카드 내역과 같은 갈래로 둬', '대사할 때 한 곳에서 봅니다']], auto: [['매월 마감 다음 날 결산 초안 만들어 둬', '같은 양식으로 초안이 먼저 생겨요'], ['카드 내역 올라오면 증빙 없는 건 표시해 둬', '빠진 것만 목록으로']], watch: [['지난달과 20% 넘게 차이 나는 항목이 있으면 알려 줘', '이상 항목을 리브가 먼저 짚어요'], ['증빙 없는 지출이 남아 있으면 알려 줘', '마감 전에 말을 겁니다']] },
      wiki: [
        { t: '8월 정산 — 전월 대비 달라진 항목 4건', kind: '대조', src: ['8월 정산.xlsx', '7월 결산 보고.xlsx'], when: '어제', body: '· 광고비 +180만원 (신규 캠페인)\n· 소프트웨어 구독 2건 신규\n· 출장비 0원 (전월 320만원)\n· 임차료 계약 갱신 +5%' },
        { t: '증빙 없는 카드 내역 3건', kind: '사실', src: ['법인카드 내역.xlsx'], when: '어제', body: '· 8/03 소프트웨어 구독 12만원\n· 8/11 식대 8만원\n· 8/19 택시 3.2만원' },
        { t: '자료 갈래 — 정산 · 증빙 · 회의록', kind: '정리 규칙', src: ['자료 41건'], when: '처음 설정 때', body: '정산·결산 21 · 증빙·전표 13 · 회의록 7. 정산은 월별로 묶습니다.' },
      ],
    },
    '1인 사업': {
      detail: { q: '어떤 일로 벌고 계세요?', opts: [['free', '프리랜서·용역'], ['shop', '온라인 판매'], ['store', '오프라인 매장'], ['con', '컨설팅·강의']] },
      jobs: {
        free: ['견적·회신', '계약 관리', '작업 진행', '정산·세금', '고객 응대', '포트폴리오 정리'],
        shop: ['상품 등록', '고객 문의 대응', '재고·발주', '매출 확인', '홍보 콘텐츠', '정산·세금'],
        store: ['매장 운영', '재고·발주', '고객 응대', '매출 확인', '직원 일정', '정산·세금'],
        con: ['제안서 쓰기', '강의 자료 준비', '일정 조율', '정산·세금', '고객 후속 관리', '콘텐츠 발행'],
      },
      guess: { line: (d) => `${d} 하시면 보통 <b>견적·제안을 매번 새로 쓰느라</b> 시간을 쓰십니다.`, alt: ['아니요 — 같은 문의에 반복해서 답하는 게 힘들어요', '아니요 — 미수금·정산 챙기는 게 문제예요'] },
      files: ['견적서_A사_v2.docx', '계약서_B사.pdf', '고객 문의 정리.xlsx', '8월 매출.xlsx', '제안서 템플릿.pptx', '세금계산서 8월.pdf', '2024_최종_진짜최종.pptx', '무제 문서(3).docx'],
      tally: [['견적·계약', 16], ['고객 응대', 14], ['정산·세금', 9]],
      firstq: ['A사 견적 조건이 B사와 어떻게 달랐지?', '자주 오는 문의 3개랑 내가 한 답변 정리해 줘', '8월 매출에서 아직 안 들어온 건 뭐야?'],
      answers: [
        { html: `세 가지가 달랐습니다.<br>· 단가 — A사 시간당 8만 / B사 프로젝트 정액 900만<br>· 수정 횟수 — A사 3회 / B사 무제한<br>· 대금 — A사 월 정산 / B사 완료 후 30일`, ev: [['견적서_A사_v2', '근거'], ['계약서_B사', '근거']], read: '읽은 것 2건 · 12초', ladder: ['다음 견적은 어느 조건으로 쓸지 초안 만들어 줘'] },
        { html: `반복 문의 <b>3가지</b>입니다.<br>· 작업 기간이 얼마나 걸리나 (11건)<br>· 수정은 몇 번까지 (8건)<br>· 세금계산서 발행 되나 (6건)<br>각각 지난 답변을 정리해 두었습니다.`, ev: [['고객 문의 정리', '근거']], read: '읽은 것 1건 · 10초', ladder: ['자주 묻는 질문 안내문으로 만들어 줘'] },
        { html: `미수 <b>2건 · 640만원</b>입니다.<br>· A사 8월분 340만원 — 지급일 8/31<br>· C사 잔금 300만원 — 완료 후 30일(9/12)`, ev: [['8월 매출', '근거'], ['세금계산서 8월', '근거']], read: '읽은 것 2건 · 11초', ladder: ['정중한 입금 안내 문구 써 줘'] },
      ],
      sugs: [['견적', '지난 견적 조건으로 새 견적 초안 써 줘'], ['문의', '자주 오는 문의 답변 정리해 줘'], ['정산', '8월에 아직 안 들어온 돈 정리해 줘']],
      bottle: [
        { t: '견적서를 매번 처음부터 쓰고 계세요', ev: '견적서 여러 건이 템플릿과 따로', fix: '지난 견적 조건을 기준으로 초안 만들어 두기', slip: '자동: 견적 초안' },
        { t: '같은 문의에 반복해서 답하고 계세요', ev: '고객 문의 정리에 같은 질문 25건', fix: '반복 문의와 내 답변을 모아 두고 재사용', slip: '자주 묻는 질문 정리' },
        { t: '미수금이 한눈에 안 보여요', ev: '매출·계약·세금계산서가 흩어짐', fix: '입금 예정일을 모아 두고 지나면 알려 주기', slip: '점검: 미수금 감시' },
      ],
      map: { tidy: [['견적·계약은 고객사별로 묶어 줘', '고객마다 이력이 한 줄로 따라붙어요'], ['문의는 주제별로 정리해 줘', '반복 질문이 모여요']], auto: [['새 견적 요청이 오면 지난 조건으로 초안 만들어 둬', '초안이 먼저 생겨요'], ['매월 말 미수금 정리해 줘', '안 들어온 돈이 목록으로']], watch: [['입금 예정일이 지나면 알려 줘', '미수를 리브가 먼저 짚어요'], ['같은 문의가 3번 넘게 오면 알려 줘', '안내문으로 만들 때가 됐다는 신호']] },
      wiki: [
        { t: '고객사별 견적 조건 비교', kind: '대조', src: ['견적서_A사_v2.docx', '계약서_B사.pdf'], when: '어제', body: '· 단가 — A사 시간당 8만 / B사 정액 900만\n· 수정 — A사 3회 / B사 무제한\n· 대금 — A사 월 정산 / B사 완료 후 30일' },
        { t: '반복 문의 3가지와 답변', kind: '종합', src: ['고객 문의 정리.xlsx'], when: '어제', body: '· 작업 기간 (11건)\n· 수정 횟수 (8건)\n· 세금계산서 발행 (6건)' },
        { t: '자료 갈래 — 견적·계약 · 고객 응대 · 정산', kind: '정리 규칙', src: ['자료 41건'], when: '처음 설정 때', body: '견적·계약 16 · 고객 응대 14 · 정산·세금 9. 견적·계약은 고객사별로 묶습니다.' },
      ],
    },
    '학생': {
      detail: { q: '지금 어느 쪽에 가까우세요?', opts: [['low', '1~2학년'], ['high', '3~4학년'], ['grad', '졸업·취업 준비'], ['out', '전공 밖 활동이 많음']] },
      jobs: {
        low: ['강의 정리', '과제·레포트', '시험 준비', '팀플', '동아리 활동', '발표 준비'],
        high: ['과제·레포트', '팀플', '전공 심화 공부', '대외활동·공모전', '인턴 준비', '발표 준비'],
        grad: ['자소서·지원서', '포트폴리오 정리', '면접 준비', '자격증 공부', '졸업 요건 확인', '과제·레포트'],
        out: ['동아리·학회 운영', '공모전 준비', '사이드 프로젝트', '대외 발표', '과제·레포트', '일정 관리'],
      },
      guess: { line: (d) => `${d}이시면 보통 <b>강의자료·필기·과제가 흩어져 있어서</b>, 과제 쓸 때 지난 자료를 다시 찾느라 시간을 쓰십니다.`, alt: ['아니요 — 팀플 정리가 더 힘들어요', '아니요 — 같은 파일이 여러 벌이라 헷갈려요'] },
      files: ['강의노트_경영전략.pdf', '과제_3주차.docx', '팀플 자료조사.pptx', '시험범위 정리.md', '8/12 팀플 회의.m4a', '참고문헌 모음.pdf', '2024_최종_진짜최종.pptx', '무제 문서(3).docx'],
      tally: [['강의·필기', 19], ['과제·레포트', 14], ['팀플·발표', 8]],
      firstq: ['지난주 경영전략 강의에서 시험에 나온다고 한 게 뭐였지?', '3주차 과제에 쓸 참고문헌 정리해 줘', '8/12 팀플 회의에서 내가 맡기로 한 게 뭐야?'],
      answers: [
        { html: `<b>세 군데</b>를 짚으셨어요.<br>· 5주차 경쟁우위 프레임 — "이건 꼭 나온다"<br>· 사례 분석 2개 (애플·넷플릭스)<br>· 마지막 주 요약 슬라이드 전체`, ev: [['강의노트_경영전략', '근거'], ['시험범위 정리', '근거']], read: '읽은 것 2건 · 10초', ladder: ['이 범위로 요약 정리 만들어 줘'] },
        { html: `과제 주제에 맞는 자료 <b>5건</b>을 찾았습니다.<br>· 참고문헌 모음에서 3건 (경쟁전략 관련)<br>· 강의노트 5주차 프레임 1건<br>· 팀플 자료조사에서 사례 1건`, ev: [['참고문헌 모음', '근거'], ['강의노트_경영전략', '근거']], read: '읽은 것 3건 · 12초', ladder: ['인용 형식으로 정리해 줘'] },
        { html: `두 가지를 맡으셨어요.<br>· 사례 조사 2개 — 목요일까지<br>· 발표 슬라이드 3~7페이지<br>다음 모임은 8/19입니다.`, ev: [['8/12 팀플 회의', '근거']], read: '읽은 것 1건 · 8초', ladder: ['내 할 일만 목록으로 만들어 줘'] },
      ],
      sugs: [['강의', '지난주 강의에서 시험에 나온다고 한 것 정리해 줘'], ['과제', '3주차 과제에 쓸 자료 찾아 줘'], ['팀플', '팀플 회의에서 내가 맡은 것 알려 줘']],
      bottle: [
        { t: '강의자료·필기·과제가 흩어져 있어요', ev: '강의노트 19건 · 과제 14건이 서로 연결 없음', fix: '과목별로 묶고, 과제마다 관련 강의자료를 이어 두기', slip: '과목별 정리 규칙' },
        { t: '팀플 회의는 녹음만 있고 역할이 안 남아요', ev: '8/12 팀플 회의 녹음만 있음', fix: '회의가 올라오면 누가 뭘 맡았는지만 뽑아 두기', slip: '자동: 팀플 회의 → 역할·기한' },
        { t: '같은 과제 파일이 여러 벌이에요', ev: '2024_최종_진짜최종.pptx 외 2벌', fix: '최종본을 하나로 정하고 나머지는 이력으로', slip: '최신 기준 고정 · 발표자료' },
      ],
      map: { tidy: [['강의자료는 과목별로 묶어 줘', '경영전략·마케팅원론이 갈래로 나뉘어요'], ['과제는 마감일 순으로 정리해 줘', '급한 것부터 위로 옵니다']], auto: [['강의자료 올리면 핵심만 요약해 둬', '자료마다 요약이 먼저 생겨요'], ['시험 2주 전에 범위 정리해 줘', '강의노트에서 범위를 모아 둡니다']], watch: [['교수님이 시험에 나온다고 한 부분이 있으면 표시해 줘', '강조한 곳을 리브가 모아 둬요'], ['과제 마감이 3일 남으면 알려 줘', '마감을 놓치지 않게 말을 겁니다']] },
      wiki: [
        { t: '경영전략 — 시험에 나온다고 한 곳 3군데', kind: '종합', src: ['강의노트_경영전략.pdf', '시험범위 정리.md'], when: '어제', body: '· 5주차 경쟁우위 프레임 — "이건 꼭 나온다"\n· 사례 분석 2개 (애플·넷플릭스)\n· 마지막 주 요약 슬라이드 전체' },
        { t: '8/12 팀플 — 내 역할 2건', kind: '회의 요약', src: ['8/12 팀플 회의.m4a'], when: '어제', body: '· 사례 조사 2개 — 목요일까지\n· 발표 슬라이드 3~7페이지\n다음 모임 8/19' },
        { t: '자료 갈래 — 강의·과제·팀플', kind: '정리 규칙', src: ['자료 41건'], when: '처음 설정 때', body: '강의·필기 19 · 과제·레포트 14 · 팀플·발표 8. 강의자료는 과목별로 묶습니다.' },
      ],
    },
  };
  const P = () => PERSONA[roleOf()] || PERSONA['마케팅'];
  const detailOf = () => { const d = P().detail.opts.find(([id]) => id === S.detail); return d ? d[1] : P().detail.opts[0][1]; };
  const detailId = () => (P().detail.opts.some(([id]) => id === S.detail) ? S.detail : P().detail.opts[0][0]);
  const fromP = (key) => Object.fromEntries(Object.entries(PERSONA).map(([k, v]) => [k, v[key]]).concat([['default', PERSONA['마케팅'][key]]]));
  const pick = (map, role) => map[role] || map.default;
  const FILES_BY_ROLE = fromP('files'), TALLY_BY_ROLE = fromP('tally'), FIRSTQ_BY_ROLE = fromP('firstq'), SUGS_BY_ROLE = fromP('sugs');

  /* ───────────────────────── 상태 ───────────────────────── */
  const KEY = 'lvly-proto-v3';
  const fresh = () => ({
    route: '#/start', name: '상민', day: 1, team: false, boardOn: false, invitesLeft: 3, ws: 'me', livView: 'chat', livMapOpen: false,
    ob: { started: false, startedAt: null, finishedAt: null, step: 0, doneSteps: [], skipped: false, finished: false, scene: null, returnTo: null,
      buildProg: 0, honest: false, firstQ: null, answered: false, freeLeft: 3 },
    role: null, detail: null, pain: null, fixes: [], jobs: [], sources: [], files: [], drop: false,
    ingest: { total: 0, done: 0, running: false, finished: false, tally: [] },
    conn: { gdrive: 'off', notion: 'off', slack: 'off', gmail: 'off', clickup: 'off' },
    ai: null, aiConnected: false, terminal: null, node: false,
    decisions: [], declined: [], knowledge: 0, usage: 0,
    work: [], library: [], livDismissed: [], toast: null,
  });
  let S = load();
  function load() { try { const j = sessionStorage.getItem(KEY); if (j) { const s = JSON.parse(j); if (s && s.ob) return s; } } catch (e) {} return fresh(); }
  function save() { try { sessionStorage.setItem(KEY, JSON.stringify(S)); } catch (e) {} }
  const roleOf = () => S.role || '마케팅';

  /* ───────────────────────── 라우팅 ───────────────────────── */
  function go(hash) { if (location.hash !== hash) location.hash = hash; else render(); }
  window.addEventListener('hashchange', render);
  function toast(msg) { const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg; document.body.appendChild(t); setTimeout(() => t.remove(), 2200); }

  function render() {
    const h = location.hash || '#/start';
    S.route = h; save();
    const app = $('#app');
    if (h.startsWith('#/welcome')) { renderRoom(app); }
    else if (h.startsWith('#/start')) { app.innerHTML = tplStart(); bindStart(); }
    else { renderApp(app, h); }
    renderProto();
  }

  /* ═════════════════════════ 화면 1 · 진입 ═════════════════════════ */
  function tplStart() {
    return `<div class="start"><div class="start-card reveal">
      <div class="wordmark">Lively <i class="pulse-dot"></i></div>
      <h1>내 일을 아는 AI와 일합니다.</h1>
      <p class="lede">준비는 3분이면 끝납니다.</p>
      <button class="btn btn-primary start-google" data-act="google"><svg class="ic" viewBox="0 0 24 24" style="stroke:none;fill:currentColor"><path d="M21.6 12.2c0-.7-.1-1.3-.2-1.9H12v3.7h5.4a4.6 4.6 0 0 1-2 3v2.5h3.2c1.9-1.7 3-4.3 3-7.3z" opacity=".9"/><path d="M12 22c2.7 0 5-.9 6.6-2.4l-3.2-2.5c-.9.6-2 1-3.4 1-2.6 0-4.8-1.8-5.6-4.1H3.1v2.6A10 10 0 0 0 12 22z" opacity=".75"/><path d="M6.4 13.9A6 6 0 0 1 6.1 12c0-.7.1-1.3.3-1.9V7.5H3.1A10 10 0 0 0 2 12c0 1.6.4 3.1 1.1 4.5l3.3-2.6z" opacity=".6"/><path d="M12 6c1.5 0 2.8.5 3.8 1.5l2.9-2.9A10 10 0 0 0 3.1 7.5l3.3 2.6C7.2 7.8 9.4 6 12 6z" opacity=".85"/></svg>구글로 계속하기</button>
      <div class="start-or">또는 이메일로 계속하기</div>
      <input class="in start-email" type="email" placeholder="you@example.com" aria-label="이메일">
      <div class="start-invite"><span class="k">초대 코드</span><span class="code">lvi-8f2k-q7m3-xn1p</span><span class="tag mint">확인됨</span></div>
      <div class="start-fine">지금은 무료 · 초대제 베타입니다. 정식 출시 때 유료 플랜으로 바뀝니다. AI 세션은 <b>쓰시던 AI 계정을 연결해</b> 돌아가고, 라이블리가 대신 결제하지 않습니다. 베타 기간에는 Claude로 실행되며 Codex·Gemini·Grok은 준비 중입니다.
        <label><input type="checkbox" id="agree"> <span><a href="terms.html" target="_blank" rel="noopener">이용약관</a>과 <a href="privacy.html" target="_blank" rel="noopener">개인정보 처리방침</a>에 동의합니다.</span></label></div>
      <div class="start-foot">초대 코드가 없으면 <a href="#" data-act="wait">대기자 등록</a>으로 남길 수 있습니다.</div>
    </div></div>`;
  }
  function bindStart() {
    // 동의는 **실제로 막는다**(#1813) — 종전엔 체크박스를 아예 읽지 않아 동의 없이도 그냥 지나갔다.
    //  문구만 있고 검사도 문서도 없으면 그건 동의를 받은 것이 아니라 받은 척한 것이다.
    $('[data-act="google"]').addEventListener('click', (e) => {
      const agree = $('#agree');
      if (agree && !agree.checked) {
        const lb = agree.closest('label');
        if (lb) { lb.classList.add('need'); setTimeout(() => lb.classList.remove('need'), 1400); }
        agree.focus();
        toast('이용약관과 개인정보 처리방침에 동의해 주세요.');
        return;
      }
      const b = e.currentTarget; b.classList.add('is-busy');
      setTimeout(() => { S = Object.assign(fresh(), { name: '상민' }); S.ob.started = true; S.ob.startedAt = Date.now(); save(); go('#/welcome'); }, 900);
    });
    $('[data-act="wait"]').addEventListener('click', (e) => { e.preventDefault(); toast('대기자 등록은 이 화면 안에서 접힙니다(프로토타입).'); });
  }

  /* ═════════════════════════ 화면 2 · 온보딩 룸 — 풀스크린 위저드 ═════════════════════════
     UI 계약(2026-08-16 재설계): **한 번에 한 장면.** 질문은 화면 가운데에 크게, 선택지는 그 아래에 크게.
     · 리브는 채팅 전사가 아니라 질문 위의 한 줄(리드)로 존재한다 — 답한 기록은 오른쪽 장부가 든다.
     · 단일 선택 = 탭 즉시 진행 · 복수 선택 = 고르는 순간 "n개로 계속" · 건너뛰기는 선택지 아래 조용한 글줄.
     · 입력창 없음 — 자유 대화는 첫 답이 끝난 뒤 홈에서 이어진다. */
  let stageEl = null, buildEl = null, ingestTimer = null, buildTimer = null, sceneToken = 0, readTimer = null;

  const SCENE_DOT = { role: 1, detail: 1, jobs: 1, guess: 1, sources: 2, upload: 2, ai: 3, claude: 3, terminal: 3, reading: 4, found: 4, firstq: 5, answer: 5, done: 5 };
  const SCENE_BACK = {
    detail: () => 'role', jobs: () => 'detail', guess: () => 'jobs', sources: () => 'guess', upload: () => 'sources',
    ai: () => (S.sources.length && !(S.sources.length === 1 && S.sources[0] === 'none') ? 'upload' : 'sources'),
    claude: () => 'ai', terminal: () => (S.ai === 'Claude' && !S.aiConnected ? 'claude' : 'ai'),
    found: () => 'terminal',
    firstq: () => (S.ingest.total ? 'found' : 'terminal'), answer: () => 'firstq',
  };
  function setDots(cur, allDone) { S.ob.step = cur; S.ob.doneSteps = allDone ? [1, 2, 3, 4, 5] : Array.from({ length: Math.max(0, cur - 1) }, (_, i) => i + 1); save(); renderDots(); }
  function renderDots() { $$('#dots li').forEach((li) => { const i = +li.dataset.i; const done = S.ob.doneSteps.includes(i); li.classList.toggle('done', done); li.classList.toggle('now', S.ob.step === i && !done); li.title = done ? '이 단계로 돌아가 고치기' : ''; }); }
  const DOT_SCENE = { 1: 'role', 2: 'sources', 3: 'ai', 4: 'found' };
  const fmtDur = (ms) => { const s = Math.max(1, Math.round(ms / 1000)); return `${Math.floor(s / 60)}분 ${String(s % 60).padStart(2, '0')}초`; };
  function tickTime() { const el = $('#roomTime'); if (!el) return; el.textContent = S.ob.finishedAt ? `처음 한 번 · ${fmtDur(S.ob.finishedAt - S.ob.startedAt)}` : '처음 한 번 · 3분'; }


  /* 일러스트 폐기(2026-08-20 원준 지시) — 캐릭터 없이 v2 셸 문법(점+글자)로. */
  const ILLOS = {};
  const ILLO_ANIM = new Set();
  const illoSVG = () => '';
  const livFace = () => `<i class="lmark" aria-hidden="true"></i>`;
  const sparkFace = () => `<i class="lmark ai" aria-hidden="true"></i>`;

  function renderRoom(app) {
    if (!S.ob.started) { S.ob.started = true; S.ob.startedAt = Date.now(); }
    app.innerHTML = `<div class="room">
      <header class="room-head">
        <div class="wordmark">Lively <i class="pulse-dot"></i> <span class="room-sub">처음 설정</span></div>
        <div class="room-prog"><span class="room-time" id="roomTime">처음 한 번 · 3분</span>
          <ol class="dots" id="dots" aria-label="진행">${[1,2,3,4,5].map((i)=>`<li data-i="${i}"></li>`).join('')}</ol>
          <button class="btn btn-ghost btn-sm" data-act="skip-all">나중에 하기 ${ic('arrow','ic-sm')}</button></div>
      </header>
      <div class="room-body">
        <section class="stage" id="stage" aria-live="polite"></section>
        <aside class="build" id="build" aria-label="만들어지는 내 워크스페이스"></aside>
      </div></div>`;
    stageEl = $('#stage'); buildEl = $('#build');
    $('[data-act="skip-all"]').addEventListener('click', skipAll);
    $('#dots').addEventListener('click', (e) => { const li = e.target.closest('li.done'); if (!li) return; const i = +li.dataset.i; const key = i === 5 ? 'firstq' : DOT_SCENE[i]; if (!key || key === S.ob.scene) return; S.ob.returnTo = S.ob.scene; goScene(key, { fix: true }); });
    renderBuild(); tickTime(); startBuildMeter(); resumeIngest();
    const scene = S.ob.finished ? 'done' : (S.ob.scene || 'role');
    renderScene(scene, false);
  }
  const FIX_CHAIN = { sources: 'upload', ai: 'claude' }; // 고치기 중에도 이어져야 하는 다음 장면
  async function goScene(key, opts) {
    if (S.ob.returnTo && !(opts && opts.fix)) {
      const cur = S.ob.scene;
      if (key !== S.ob.returnTo && FIX_CHAIN[cur] !== key) { key = S.ob.returnTo; S.ob.returnTo = null; }
      else if (key === S.ob.returnTo) S.ob.returnTo = null;
    }
    S.ob.scene = key; save(); await renderScene(key, true);
  }
  async function renderScene(key, animate) {
    const token = ++sceneToken; clearInterval(readTimer);
    setDots(SCENE_DOT[key] || 5, key === 'done' || S.ob.finished);
    if (animate && stageEl.firstElementChild) { stageEl.firstElementChild.classList.add('sc-leave'); await wait(130); if (token !== sceneToken) return; }
    const sc = SCENES[key]; if (!sc) return;
    const el = document.createElement('div');
    el.className = 'scene' + (sc.cls ? ' ' + sc.cls : ''); if (!animate) el.style.animation = 'none';
    const ret = S.ob.returnTo && S.ob.returnTo !== key ? S.ob.returnTo : null;
    const back = ret || (SCENE_BACK[key] ? SCENE_BACK[key]() : null);
    const ill = ILLOS[key] ? `<div class="sc-illo${ILLO_ANIM.has(key) ? ' anim' : ''}">${illoSVG(key)}</div>` : '';
    el.innerHTML = (back && (ret || !S.ob.finished) ? `<div class="sc-nav"><button type="button" class="btn-text sc-back" data-back="${back}">← ${ret ? '그대로 두고 돌아가기' : '이전'}</button></div>` : '') + ill + sc.html();
    stageEl.replaceChildren(el);
    const bb = $('.sc-back', el); if (bb) bb.addEventListener('click', () => goScene(bb.dataset.back));
    if (sc.bind) sc.bind(el, token);
  }
  const scHead = (lead, q, help) => `${lead ? `<div class="sc-lead">${livFace(21)}<span>리브</span></div><p class="sc-say">${lead}</p>` : ''}${q ? `<h2 class="sc-q">${q}</h2>` : ''}${help ? `<p class="sc-help">${help}</p>` : ''}`;

  /* 선택지 — 단일: 탭 즉시 진행 / 복수: n개로 계속 / 직접 적기·건너뛰기 */
  function bindChoice(el, { multi, none, onCommit, onSkip }) {
    const opts = $('.sc-opts', el), goWrap = $('.sc-go', el), go = goWrap ? $('button', goWrap) : null, wr = $('.sc-write', el), win = wr ? $('input', wr) : null;
    const extra = [];
    const chosen = () => $$('.chip.on[data-opt]', opts).map((c) => c.dataset.opt).concat(extra);
    const syncGo = () => { if (!goWrap) return; const n = chosen().length; goWrap.hidden = n === 0; if (go) go.textContent = `${n}개로 계속`; };
    syncGo();
    let committed = false;
    const commit = (sel) => { if (committed) return; committed = true; el.classList.add('sc-leave-soft'); onCommit(sel); };
    $$('.chip[data-opt]', opts).forEach((c) => c.addEventListener('click', () => {
      if (committed) return;
      if (!multi || c.dataset.none === '1') { $$('.chip[data-opt]', opts).forEach((x) => x.classList.remove('on')); c.classList.add('on'); setTimeout(() => commit([c.dataset.opt]), 170); return; }
      c.classList.toggle('on'); syncGo();
    }));
    if (go) go.addEventListener('click', () => { const sel = chosen(); if (sel.length) commit(sel); });
    const wbtn = $('[data-esc="write"]', el);
    if (wbtn) wbtn.addEventListener('click', () => { wr.hidden = false; wbtn.hidden = true; win.focus(); });
    if (win) {
      const commitWrite = () => {
        const v = (win.value || '').trim(); if (!v) return;
        if (!multi) return commit([v]);
        extra.push(v);
        const chipEl = document.createElement('button'); chipEl.type = 'button'; chipEl.className = 'chip on'; chipEl.textContent = v;
        chipEl.addEventListener('click', () => { const i = extra.indexOf(v); if (i >= 0) extra.splice(i, 1); chipEl.remove(); syncGo(); });
        opts.appendChild(chipEl); win.value = ''; wr.hidden = true; if (wbtn) wbtn.hidden = false; syncGo();
      };
      win.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); commitWrite(); } });
      $('button', wr).addEventListener('click', commitWrite);
    }
    const sk = $('[data-esc="skip"]', el); if (sk && onSkip) sk.addEventListener('click', () => { if (committed) return; committed = true; onSkip(); });
  }
  const chipsHTML = (options, sel) => options.map((o, i) => { const id = typeof o === 'string' ? o : o.id; const label = typeof o === 'string' ? o : o.label; const none = typeof o === 'object' && o.none; const on = (sel || []).includes(id); return `<button type="button" class="chip${on ? ' on' : ''}${none ? ' chip-dim' : ''}" data-opt="${esc(id)}" data-none="${none ? 1 : 0}" style="animation-delay:${Math.min(60 + i * 40, 460)}ms">${esc(label)}</button>`; }).join('');
  const choiceHTML = (spec) => `<div class="sc-opts">${chipsHTML(spec.options, spec.sel)}${spec.other ? `<button type="button" class="chip chip-esc" data-esc="write" style="animation-delay:${Math.min(60 + spec.options.length * 40, 500)}ms">＋ ${esc(spec.other)}</button>` : ''}</div>
    ${spec.multi ? `<div class="sc-go" hidden><button type="button" class="btn btn-primary">계속</button></div>` : ''}
    <div class="sc-write" hidden><input class="in" type="text" placeholder="여기에 적어 주세요"><button type="button" class="btn btn-ghost btn-sm">확인</button></div>
    ${spec.skip ? `<div class="sc-skip"><button type="button" class="btn-text" data-esc="skip">${esc(spec.skip)}</button></div>` : ''}`;

  const jobOpts = () => P().jobs[detailId()];
  /* 병목 — Q4에서 사람이 정정한 것을 1번으로 올린다 */
  const bottles = () => { const b = P().bottle.slice(); const i = S.pain; if (i === 1) return [b[1], b[0], b[2]]; if (i === 2) return [b[2], b[0], b[1]]; return b; };

  /* ── 장면들 ── */
  const SCENES = {
    role: {
      html: () => scHead('안녕하세요, 저는 리브예요. 이 워크스페이스를 계속 돌봐 드릴 담당자입니다. 몇 가지만 여쭙고, <b>제가 본 것</b>을 말씀드릴게요.', '어떤 일을 하고 계세요?', '여기서 고르신 것에 따라 다음 질문이 완전히 달라집니다.') + choiceHTML({ options: ROLES, sel: S.role ? [S.role] : [], other: '직접 적기', skip: '나중에 정할게요' }),
      bind: (el) => bindChoice(el, { onCommit: (sel) => { if (S.role !== sel[0]) { S.detail = null; S.jobs = []; S.pain = null; } S.role = sel[0]; save(); renderBuild(); flashCard('#bcMe'); goScene('detail'); }, onSkip: () => { S.role = '마케팅'; save(); goScene('detail'); } }),
    },
    detail: {
      html: () => scHead(`${esc(roleOf())}이시군요.`, P().detail.q, '같은 직업이어도 여기서 하는 일이 갈립니다 — 다음 질문을 이걸로 만듭니다.') + choiceHTML({ options: P().detail.opts.map(([id, label]) => ({ id, label })), sel: S.detail ? [S.detail] : [], skip: '해당 없음' }),
      bind: (el) => bindChoice(el, { onCommit: (sel) => { if (S.detail !== sel[0]) S.jobs = []; S.detail = sel[0]; save(); renderBuild(); flashCard('#bcMe'); goScene('jobs'); }, onSkip: () => { S.detail = P().detail.opts[0][0]; save(); goScene('jobs'); } }),
    },
    jobs: {
      html: () => scHead(`${esc(detailOf())} 쪽이시군요.`, '이 중에 시간을 제일 많이 쓰는 일은?', '여러 개 골라도 됩니다 — 자료를 읽을 때 이 눈으로 봅니다.') + choiceHTML({ multi: true, options: jobOpts(), sel: S.jobs, other: '직접 적기', skip: '건너뛰기' }),
      bind: (el) => bindChoice(el, { multi: true, onCommit: (sel) => { S.jobs = sel; S.decisions = [`분류 ${pick(TALLY_BY_ROLE, roleOf()).length}갈래(${pick(TALLY_BY_ROLE, roleOf()).map((t) => t[0]).join('·')})`].concat(S.decisions.filter((d) => !d.startsWith('분류'))); save(); renderBuild(); flashCard('#bcMe'); goScene('guess'); }, onSkip: () => goScene('guess') }),
    },
    guess: {
      html: () => {
        const b = P().bottle;
        return scHead('그럼 하나 맞혀 볼게요.', '이게 제일 손이 가는 일 아닌가요?', '틀렸으면 고쳐 주세요 — 그대로 제 판단이 됩니다.')
          + `<div class="sc-guess">${P().guess.line(detailOf())}</div>`
          + choiceHTML({ options: [{ id: '0', label: '맞아요, 그게 제일 큽니다' }, { id: '1', label: P().guess.alt[0] }, { id: '2', label: P().guess.alt[1] }], sel: S.pain != null ? [String(S.pain)] : [] });
      },
      bind: (el) => bindChoice(el, { onCommit: (sel) => { S.pain = +sel[0]; save(); renderBuild(); goScene('sources'); } }),
    },
    sources: {
      html: () => scHead('이제 <b>확인할 차례</b>예요. 자료를 보면 제 짐작이 맞는지 알 수 있습니다.', '지금까지 일한 내용은 주로 어디에 쌓아 두셨어요?', '여러 개 골라도 됩니다. 살아 있는 서비스는 연결해 두면 새 자료가 계속 따라옵니다.') + choiceHTML({ multi: true, options: SOURCES.map((s) => ({ id: s.id, label: s.label, none: s.none })), sel: S.sources, skip: '건너뛰기' }),
      bind: (el) => bindChoice(el, { multi: true, onCommit: async (sel) => { S.sources = sel; save(); renderBuild(); if (sel.includes('none') && sel.length === 1) return goScene('ai'); goScene('upload'); }, onSkip: () => goScene('ai') }),
    },
    upload: {
      cls: 'wide',
      html: () => {
        const live = SOURCES.filter((s) => S.sources.includes(s.id) && s.live);
        const oauth = live.filter((s) => ['gdrive', 'notion'].includes(s.id));
        const later = live.filter((s) => !['gdrive', 'notion'].includes(s.id));
        const local = S.sources.some((id) => id === 'folder' || id === 'git');
        const files = S.files.length ? `<div class="drop filled"><b>${S.files.length}개 받았어요</b><div class="filelist">${S.files.slice(0, 6).map((f) => `<span class="f">${ic(f.endsWith('.m4a') ? 'mic' : f.endsWith('.xlsx') ? 'sheet' : 'doc')}${esc(f)}</span>`).join('')}<span class="more">외 ${S.files.length - 6}개</span></div></div>`
          : `<div class="drop" data-drop role="button" tabindex="0"><b>여기에 파일이나 폴더를 끌어다 놓기</b><span>pdf · docx · pptx · xlsx · md · m4a</span></div>`;
        const conn = (s) => { const st = S.conn[s.id]; return `<div class="conn"><span class="logo">${esc(s.logo)}</span><div><div class="t">${esc(s.label)}</div><div class="s">${st === 'on' ? '연결됐어요 · 읽기만 · 새 자료 자동 반영' : '읽기 권한만 · 한 번이면 됩니다'}</div></div>${st === 'on' ? `<span class="state on" style="margin-left:auto">연결됨</span>` : `<button type="button" class="btn btn-ghost btn-sm${st === 'busy' ? ' is-busy' : ''}" data-connect="${s.id}">${s.id === 'gdrive' ? '구글로 연결' : '노션 연결'}</button>`}</div>`; };
        const has = S.files.length > 0 || Object.values(S.conn).some((v) => v === 'on' || v === 'busy');
        const liveNames = oauth.map((s) => s.label).join('·');
        return scHead(liveNames ? `${esc(liveNames)}은 한 번 연결하면 계속 새 자료가 따라옵니다.` : '파일이 손에 있으면 그냥 끌어다 놓으시면 됩니다.', '자료를 넘겨주세요.', '폴더 정리도, 이름 짓기도 필요 없습니다 — 읽는 동안 다음으로 넘어갑니다.')
          + `<div class="sc-body"><div class="src-grid">${files}<div class="src-col">${oauth.map(conn).join('')}${later.map((s) => `<div class="conn ghost"><span class="logo">${esc(s.logo)}</span><div><div class="t">${esc(s.label)}</div><div class="s">앱 발급이 한 번 필요해서 <b>홈에서 한 걸음씩</b> 안내할게요.</div></div><span class="state wait" style="margin-left:auto">나중에</span></div>`).join('')}${local ? `<div class="conn ghost"><span class="logo">${ic('term')}</span><div><div class="t">내 컴퓨터 폴더</div><div class="s">한 줄만 실행하면 리브가 그 폴더를 읽습니다.</div></div><button type="button" class="btn btn-ghost btn-sm" data-copy style="margin-left:auto">명령 복사</button></div>` : ''}</div></div></div>
          <div class="sc-actions">${has ? `<button type="button" class="btn btn-primary" data-done>다 넣었어요 — 계속</button>` : ''}</div>
          <div class="sc-skip"><button type="button" class="btn-text" data-skip>지금은 건너뛰기</button></div>`;
      },
      bind: (el) => {
        const drop = $('[data-drop]', el);
        if (drop) {
          const doDrop = () => { S.files = pick(FILES_BY_ROLE, roleOf()).concat(Array.from({ length: 33 }, (_, i) => `file-${i}`)); save(); startIngest(41); renderScene('upload', false); toast('41개를 받았어요.'); };
          drop.addEventListener('click', doDrop); drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); doDrop(); } });
          drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); }); drop.addEventListener('dragleave', () => drop.classList.remove('over')); drop.addEventListener('drop', (e) => { e.preventDefault(); doDrop(); });
        }
        $$('[data-connect]', el).forEach((b) => b.addEventListener('click', () => { const id = b.dataset.connect; S.conn[id] = 'busy'; save(); renderScene('upload', false); toast(id === 'gdrive' ? '새 탭에서 구글 허용을 기다리는 중…' : '새 탭에서 노션 허용을 기다리는 중…'); setTimeout(() => { S.conn[id] = 'on'; if (!S.ingest.total) startIngest(41); save(); renderBuild(); if (S.ob.scene === 'upload') renderScene('upload', false); }, 1400); }));
        $$('[data-copy]', el).forEach((b) => b.addEventListener('click', () => copyText('lively node --daemon')));
        const d = $('[data-done]', el); if (d) d.addEventListener('click', () => goScene('ai'));
        const sk = $('[data-skip]', el); if (sk) sk.addEventListener('click', () => { S.declined.push('upload'); save(); goScene('ai'); });
      },
    },
    ai: {
      html: () => scHead(S.ingest.total && !S.ingest.finished ? '자료를 읽는 동안 하나 더요.' : '이제 AI 차례예요.', '평소 어떤 AI를 쓰세요?', '쓰던 AI를 그대로 씁니다 — 새로 결제할 것은 없습니다.') + choiceHTML({ options: AIS, sel: S.ai ? [S.ai] : [], skip: '나중에 정할게요' }),
      bind: (el) => bindChoice(el, { onCommit: async (sel) => { S.ai = sel[0]; save(); renderBuild(); if (S.ai === 'Claude' || S.ai === '여러 개') { S.ai = 'Claude'; save(); return goScene('claude'); } S.ob.honest = true; save(); goScene('terminal'); }, onSkip: () => goScene('terminal') }),
    },
    claude: {
      cls: 'wide',
      html: () => scHead(`새 결제는 없어요. 연결한 뒤에는 저(리브)가 일할 때도 ${esc(S.name)}님의 Claude 사용량을 씁니다 — 얼마나 썼는지는 언제든 보여 드릴게요.`, 'Claude 계정을 연결해 주세요.', '새 탭에서 로그인하고 짧은 코드를 가져오면 됩니다 · 1분')
        + `<div class="sc-body"><div class="steps3"><div class="step3" data-s="a"><span class="n">① 열기</span><button type="button" class="btn btn-primary btn-sm" data-open>Claude 열기 ${ic('ext','ic-sm')}</button><span>새 탭에서 Claude에 로그인합니다.</span></div>
        <div class="step3" data-s="b"><span class="n">② 코드 복사</span><span>화면에 나오는 짧은 코드를 복사합니다.<br><span class="muted">예: <span class="mono">3F7K-QX2M</span> 처럼 생겼어요.</span></span></div>
        <div class="step3" data-s="c"><span class="n">③ 여기 붙여넣기</span><input class="in" type="text" placeholder="코드 붙여넣기" aria-label="코드"><span class="muted">붙여넣으면 제가 확인합니다.</span></div></div></div>
        <div class="sc-actions"><button type="button" class="btn btn-primary" data-go disabled>연결 확인</button></div>
        <p class="sc-fine">화면이 설명과 다르면 보이는 대로 말씀해 주세요. 연결은 언제든 끊을 수 있습니다.</p>
        <div class="sc-skip"><button type="button" class="btn-text" data-skip>나중에 할게요</button></div>`,
      bind: (el) => {
        const go = $('[data-go]', el), code = $('input.in', el);
        $('[data-open]', el).addEventListener('click', () => { $('[data-s="a"]', el).classList.add('done'); toast('새 탭에서 Claude 로그인 화면이 열렸다고 가정합니다.'); setTimeout(() => { $('[data-s="b"]', el).classList.add('done'); code.focus(); }, 800); });
        code.addEventListener('input', () => { const ok = code.value.trim().length >= 4; go.disabled = !ok; $('[data-s="c"]', el).classList.toggle('done', ok); });
        code.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !go.disabled) go.click(); });
        go.addEventListener('click', () => { go.classList.add('is-busy'); setTimeout(() => { S.aiConnected = true; save(); renderBuild(); toast('연결됐어요. 이제 답은 내 구독으로 돕니다.'); goScene('terminal'); }, 650); });
        $('[data-skip]', el).addEventListener('click', () => { S.declined.push('claude'); save(); goScene('terminal'); });
      },
    },
    terminal: {
      html: () => scHead(S.ob.honest ? `솔직히 말씀드릴게요 — 지금 베타는 <b>Claude</b>로 세션을 돌립니다. ${S.ai && S.ai !== '아직 없어요' ? `${esc(S.ai)}는 준비 중이에요. ` : ''}자료 쌓기·정리·검색은 지금부터 되고, 첫 질문 <b>3회</b>는 라이블리 계정으로 열어 드려요.` : (S.aiConnected ? '연결됐어요. 거의 끝났습니다.' : '거의 끝났습니다.'), '터미널에서 Claude Code나 Codex를 쓰시나요?', '쓰신다면 거기에도 같은 자료가 실리게 할 수 있어요.') + choiceHTML({ options: [{ id: 'yes', label: '네, 씁니다' }, { id: 'no', label: '아니요' }] }),
      bind: (el) => bindChoice(el, { onCommit: async (sel) => {
        const yes = sel[0] === 'yes'; S.terminal = yes ? 'yes' : 'no';
        if (yes) { S.node = true; S.decisions.push('내 컴퓨터 노드 연결 — 터미널의 Claude Code에도 같은 자료'); toast('홈에서 한 줄 설치를 안내할게요 — lively node --daemon'); } else { S.declined.push('terminal'); }
        save(); renderBuild();
        if (S.ingest.total && !S.ingest.finished) return goScene('reading');
        goScene(S.ingest.total ? 'found' : 'firstq');
      } }),
    },
    reading: {
      html: () => `${scHead('금방이에요.', '자료를 읽고 있어요.', `읽으면서 ${esc(detailOf())} 기준으로 보고 있어요 — 끝나면 <b>제가 본 것</b>을 말씀드립니다.`)}
        <div class="sc-read"><div class="sc-read-n" id="readN">${S.ingest.done} / ${S.ingest.total}</div><div class="meter"><i id="readBar" style="width:${Math.round(100 * S.ingest.done / Math.max(1, S.ingest.total))}%"></i></div><div class="sc-read-t" id="readT">${S.ingest.tally.map(([n, c]) => `${n} ${c}`).join(' · ') || '살펴보는 중'}</div></div>`,
      bind: (el, token) => {
        const done = () => { if (token === sceneToken) goScene('found'); };
        if (S.ingest.finished) return void setTimeout(done, 600);
        document.addEventListener('ingest-done', () => setTimeout(done, 500), { once: true });
        readTimer = setInterval(() => { const n = $('#readN', el), b = $('#readBar', el), t = $('#readT', el); if (!n) return; n.textContent = `${S.ingest.done} / ${S.ingest.total}`; b.style.width = Math.round(100 * S.ingest.done / Math.max(1, S.ingest.total)) + '%'; if (S.ingest.tally.length) t.textContent = S.ingest.tally.map(([x, c]) => `${x} ${c}`).join(' · '); }, 400);
      },
    },
    found: {
      cls: 'wide',
      html: () => {
        const B = bottles(); const T = S.ingest.tally.length ? S.ingest.tally : pick(TALLY_BY_ROLE, roleOf());
        return `${scHead(`${S.ingest.total}개를 다 읽었어요. ${S.pain === 0 ? '짐작이 맞았고, ' : ''}자료에서 <b>세 가지</b>가 보입니다.`, `${esc(S.name)}님의 일하는 방식 — 제가 본 것`, '각각 제가 대신 할 수 있는 일이 있어요. 켜 두면 다음부터 알아서 합니다.')}
        <div class="sc-tally">${T.map(([n, c], i) => `<span class="tag mint" style="animation-delay:${60 + i * 60}ms">${esc(n)} <b class="num">${c}</b></span>`).join('')}</div>
        <div class="sc-body"><div class="found">${B.map((b, i) => {
          const on = S.fixes.includes(b.slip);
          return `<article class="fnd ${on ? 'on' : ''}" data-fix="${i}">
            <div class="fnd-n">${i + 1}</div>
            <div class="fnd-b">
              <div class="fnd-t">${b.t}</div>
              <div class="fnd-ev"><span class="k">근거</span>${esc(b.ev)}</div>
              <div class="fnd-fix"><span class="k">제가 할 수 있는 것</span>${esc(b.fix)}</div>
            </div>
            <button type="button" class="btn ${on ? 'btn-ghost' : 'btn-mint'} btn-sm fnd-go">${on ? '켜짐 ✓' : '켜기'}</button>
          </article>`;
        }).join('')}</div></div>
        <div class="sc-actions"><button type="button" class="btn btn-primary" data-next>${S.fixes.length ? `${S.fixes.length}개 켜고 계속` : '나중에 정할게요'}</button></div>
        <p class="sc-fine">지금 안 켜도 됩니다 — 리브가 홈에서 다시 권합니다. 켠 것은 언제든 되돌릴 수 있어요.</p>`;
      },
      bind: (el) => {
        $$('.fnd', el).forEach((card) => card.addEventListener('click', (e) => {
          const b = bottles()[+card.dataset.fix]; const on = S.fixes.includes(b.slip);
          if (on) { S.fixes = S.fixes.filter((x) => x !== b.slip); S.decisions = S.decisions.filter((d) => d !== b.slip); S.work = S.work.filter((w) => w.id !== 'fix' + card.dataset.fix); }
          else {
            S.fixes.push(b.slip); S.decisions.push(b.slip);
            if (b.slip.startsWith('자동')) S.work.push({ id: 'fix' + card.dataset.fix, t: b.slip.replace(/^자동: /, ''), st: 'sched', when: '자동', m: '리브가 돌립니다' });
            toast(`켰어요 — ${b.fix}`);
          }
          save(); renderBuild(); renderScene('found', false);
        }));
        $('[data-next]', el).addEventListener('click', () => goScene('firstq'));
      },
    },
    firstq: {
      html: () => {
        const locked = !S.aiConnected && S.ai !== 'Claude';
        const qs = S.ingest.total ? pick(FIRSTQ_BY_ROLE, roleOf()) : [];
        return `${scHead(`${S.fixes.length ? `${S.fixes.length}가지를 켜 뒀어요. 이제` : '이제'} 저(리브)가 아니라 <b>${esc(S.name)}님의 AI</b>가 답할 차례예요.${locked ? ' 세션 연결 전이라 라이블리 계정으로 3회 열어 드려요.' : ''}`, S.ingest.total ? '첫 마디를 골라, 그대로 시켜 보세요.' : '무엇을 준비 중이세요?', S.ingest.total ? `${esc(detailOf())} · ${S.jobs.slice(0, 2).map(esc).join('·') || '하시는 일'} 기준으로 골라 둔 질문이에요.` : '한 줄만 적어 주시면 그 답을 첫 자료로 남길게요.')}
        <div class="sc-opts sc-opts-q">${qs.map((q, i) => `<button type="button" class="chip chip-q" data-q="${esc(q)}" style="animation-delay:${60 + i * 60}ms">${esc(q)}</button>`).join('')}${qs.length ? `<button type="button" class="chip chip-esc" data-esc="write" style="animation-delay:${60 + qs.length * 60}ms">＋ 직접 물어보기</button>` : ''}</div>
        <div class="sc-write" ${qs.length ? 'hidden' : ''}><input class="in" type="text" placeholder="무엇이든 물어보세요"><button type="button" class="btn btn-primary btn-sm">시키기</button></div>`;
      },
      bind: (el) => {
        $$('[data-q]', el).forEach((b) => b.addEventListener('click', () => { b.classList.add('on'); S.ob.firstQ = b.dataset.q; S.ob.answered = false; save(); setTimeout(() => goScene('answer'), 170); }));
        const wr = $('.sc-write', el), win = wr && $('input', wr);
        const wbtn = $('[data-esc="write"]', el); if (wbtn) wbtn.addEventListener('click', () => { wr.hidden = false; wbtn.hidden = true; win.focus(); });
        if (win) { const cw = () => { const v = (win.value || '').trim(); if (!v) return; S.ob.firstQ = v; S.ob.answered = false; save(); goScene('answer'); };
          win.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); cw(); } });
          $('button', wr).addEventListener('click', cw); }
      },
    },
    answer: { cls: 'wide left', html: () => answerSceneHTML(), bind: (el, token) => bindAnswerScene(el, token) },
    done: { cls: 'wide', html: () => doneSceneHTML(), bind: (el) => bindDoneScene(el) },
  };

  /* 첫 답 장면 — 이 온보딩의 보상. 질문 인용 + 내 AI의 답 카드(스트리밍) + 사다리 */
  const ANSWERS_BY_ROLE = fromP('answers');
  const genericAnswer = (q) => ({ html: `${esc(q.replace(/[?？]$/, ''))} — 자료함에서 관련 문서를 찾아 정리했어요.<br>· 근거 2건을 바탕으로 답했습니다.<br>· 결과는 자료함에 남겨 두었어요.`, ev: [['8/12 회의록', '근거'], ['7월 월간 보고서', '근거']], read: '읽은 것 2건 · 10초', ladder: ['이 내용으로 한 장짜리 정리 만들어 줘'] });
  const aiWho = () => (S.aiConnected || S.ai === 'Claude') ? '내 AI · Claude' : 'AI · 라이블리 계정 체험';
  function answerOf(q) { const qs = pick(FIRSTQ_BY_ROLE, roleOf()); const idx = qs.indexOf(q); const arr = ANSWERS_BY_ROLE[roleOf()] || ANSWERS_BY_ROLE.default; return idx >= 0 ? (arr[idx] || arr[0]) : genericAnswer(q); }
  const answerCardHTML = (A, body) => `<div class="ans-card"><div class="who ai">${sparkFace(17)}<span>${aiWho()}</span></div><div class="ans-body">${body}</div></div>`;
  function answerSceneHTML() {
    const q = S.ob.firstQ || pick(FIRSTQ_BY_ROLE, roleOf())[0];
    const A = answerOf(q);
    const full = S.ob.answered;
    const body = full ? A.html + evLadder(A) : '<span class="typing"><i></i><i></i><i></i></span>';
    return `<div class="ans-q"><span class="k">내가 시킨 것</span>${esc(q)}</div>${answerCardHTML(A, body)}<div class="sc-actions ans-actions" ${full ? '' : 'hidden'}><button type="button" class="btn btn-primary" data-finish>좋아요 — 설정 요약 보기</button></div><p class="sc-fine" ${full ? '' : 'hidden'}>이 답도 자료함에 쌓였어요. 다음 답의 재료가 됩니다.</p>`;
  }
  const evLadder = (A) => `<div class="evidence">${A.ev.map(([n, k]) => `<button type="button" class="ev"><span class="k">${k}</span>${esc(n)}</button>`).join('')}</div><div class="slip done"><span class="slip-mark">✓</span><span class="slip-name">${esc(A.read)} · 결과 → 자료함 저장</span><span class="slip-state">했음</span></div><div class="ladder"><span class="k">이것까지 시켜보세요 →</span>${A.ladder.map((l) => `<button type="button" class="chip" data-ladder="${esc(l)}">${esc(l)}</button>`).join('')}</div>`;
  async function bindAnswerScene(el, token) {
    const q = S.ob.firstQ || pick(FIRSTQ_BY_ROLE, roleOf())[0];
    const A = answerOf(q);
    const bodyEl = $('.ans-body', el);
    if (!S.ob.answered) {
      await wait(850); if (token !== sceneToken) return;
      const parts = A.html.split('<br>'); let acc = '';
      for (const p of parts) { acc += (acc ? '<br>' : '') + p; bodyEl.innerHTML = acc; await wait(260); if (token !== sceneToken) return; }
      S.usage += 1; if (!S.aiConnected && S.ai !== 'Claude') S.ob.freeLeft = Math.max(0, S.ob.freeLeft - 1);
      S.knowledge += 1; S.ob.answered = true; save(); renderBuild(); flashCard('.bc:nth-of-type(3)');
      bodyEl.innerHTML = A.html + evLadder(A);
      const act = $('.ans-actions', el), fine = $('.sc-fine', el); if (act) act.hidden = false; if (fine) fine.hidden = false;
    }
    bindLadder(el, token);
    const fin = $('[data-finish]', el); if (fin) fin.addEventListener('click', () => { finish(); goScene('done'); });
  }
  function bindLadder(el, token) {
    $$('[data-ladder]', el).forEach((b) => { if (b.dataset.bound) return; b.dataset.bound = 1; b.addEventListener('click', async () => {
      const q2 = b.dataset.ladder; b.closest('.ladder').remove();
      const card = document.createElement('div'); card.innerHTML = `<div class="ans-q"><span class="k">이어서 시킨 것</span>${esc(q2)}</div>${answerCardHTML(null, '<span class="typing"><i></i><i></i><i></i></span>')}`;
      const anchor = $('.ans-actions', el); el.insertBefore(card, anchor);
      await wait(1000); if (token !== sceneToken) return;
      const html = q2.includes('공지') ? `<b>[공지] 환불 기준 변경 안내 (초안)</b><br>9월 1일부터 환불 가능 기간이 결제일 기준 7일에서 <b>14일</b>로 늘어납니다. 8월 결제분까지는 종전 7일 기준으로 처리됩니다. 문의: 고객센터.<br><span class="ink-sub">— 8/12 회의 결정 3건을 반영했습니다. 금요일 공지 기한에 맞춰 두었어요.</span>` : q2.includes('목록') ? `할 일 3개를 <b>진행 중인 일</b>에 목록으로 만들어 두었어요.<br>☐ 공지 초안 — 금요일까지 · ☐ 디자인 시안 검토 요청 · ☐ 환불 기준 문서 갱신(v3)` : `정리했어요. 요청하신 내용은 자료함에 새 문서로 남겨 두었습니다.`;
      S.knowledge += 1; S.usage += 1; save(); renderBuild();
      $('.ans-body', card).innerHTML = html + `<div class="evidence"><button type="button" class="ev"><span class="k">근거</span>8/12 회의록</button></div><div class="slip done"><span class="slip-mark">✓</span><span class="slip-name">결과 → 자료함에 지식 1건 저장</span><span class="slip-state">했음</span></div>`;
      if (q2.includes('목록')) { S.work.push({ id: 'todo', t: '8/12 회의 할 일 3개', st: 'done', when: '방금', m: '결과 → 자료함 · 할 일 3개' }); save(); }
    }); });
  }
  function doneSceneHTML() {
    const dur = fmtDur((S.ob.finishedAt || Date.now()) - S.ob.startedAt);
    const B = bottles();
    const on = (b) => S.fixes.includes(b.slip);
    const onCount = B.filter(on).length;
    return `${scHead(`${dur} 걸렸어요. 답해 주신 것과 자료 ${S.ingest.total || 0}건에서 본 것입니다.`, `리브가 본 ${esc(S.name)}님의 일하는 방식`, `${esc(roleOf())} · ${esc(detailOf())} · ${S.jobs.slice(0, 3).map(esc).join(' · ') || '업무 미지정'}`)}
      <div class="sc-body"><div class="diag">
        ${B.map((b, i) => `<article class="dg ${on(b) ? 'on' : 'off'}">
          <div class="dg-n">${i + 1}</div>
          <div class="dg-b">
            <div class="dg-t">${b.t}</div>
            <div class="dg-ev"><span class="k">근거</span>${esc(b.ev)}</div>
            <div class="dg-fix">${on(b) ? `<span class="state on">켜 뒀어요</span> ${esc(b.fix)}` : `<span class="state off">아직</span> ${esc(b.fix)}`}</div>
          </div>
          ${on(b) ? '' : `<button type="button" class="btn btn-mint btn-sm" data-late="${i}">지금 켜기</button>`}
        </article>`).join('')}
        <div class="dg-foot">${onCount ? `<b>${onCount}가지</b>를 켜 뒀습니다 — 다음부터 제가 알아서 합니다.` : '아직 켠 것이 없어요 — 홈에서 다시 권해 드릴게요.'} 전부 되돌릴 수 있습니다.</div>
      </div>
      <div class="summary">${summaryHTML(dur)}</div></div>`;
  }
  function bindDoneScene(el) {
    $$('[data-late]', el).forEach((b) => b.addEventListener('click', () => {
      const x = bottles()[+b.dataset.late];
      if (!S.fixes.includes(x.slip)) { S.fixes.push(x.slip); S.decisions.push(x.slip); if (x.slip.startsWith('자동')) S.work.push({ id: 'fix-late' + b.dataset.late, t: x.slip.replace(/^자동: /, ''), st: 'sched', when: '자동', m: '리브가 돌립니다' }); }
      save(); renderBuild(); renderScene('done', false); toast(`켰어요 — ${x.fix}`);
    }));
    $$('[data-act="go-home"]', el).forEach((b) => b.addEventListener('click', () => go('#/home')));
    $$('[data-act="keep-summary"]', el).forEach((b) => b.addEventListener('click', () => { S.knowledge += 1; save(); renderBuild(); toast('요약을 자료함에 남겼어요.'); b.disabled = true; }));
  }
  function finish() {
    if (S.ob.finished) return; S.ob.finished = true; S.ob.finishedAt = Date.now(); setDots(5, true); tickTime();
    const first = { id: 'firstq', t: (S.ob.firstQ || pick(FIRSTQ_BY_ROLE, roleOf())[0]).replace(/\?$/, ''), st: 'done', when: '방금', m: '결과 → 자료함' };
    if (!S.work.find((w) => w.id === 'firstq')) S.work.unshift(first);
    if (!S.work.find((w) => w.id === 'ob')) S.work.push({ id: 'ob', t: '처음 설정 (리브)', st: 'done', when: '방금', m: `${fmtDur(S.ob.finishedAt - S.ob.startedAt)} · 되돌리기 가능` });
    save(); renderBuild();
  }
  function summaryHTML(dur) {
    const conns = Object.entries(S.conn).filter(([, v]) => v === 'on').map(([k]) => SOURCES.find((s) => s.id === k).label);
    const notDone = []; if (!conns.includes('노션') && !S.declined.includes('notion')) notDone.push('노션 연결'); notDone.push(`동료 초대(초대장 ${S.invitesLeft}장)`); notDone.push('매주 회의 요약 자동화');
    return `<h3>설정 요약 <span class="k">${dur}</span></h3><div class="sum-grid">
      <div class="sum-cell" data-fix="role" role="button" tabindex="0"><span class="k">나<span class="fix">고치기</span></span><b>${esc(roleOf())}</b> · ${S.jobs.map(esc).join(', ') || '—'}<br><span class="muted">AI 눈높이: ${roleOf() === '개발' ? '기술 설명 자세히' : '비개발'} · 존댓말 · 한국어</span></div>
      <div class="sum-cell"><span class="k">리브가 정한 것 <span style="text-transform:none;letter-spacing:0">(전부 되돌릴 수 있어요)</span></span>${S.decisions.map((d) => `· ${esc(d)}`).join('<br>') || '—'}</div>
      <div class="sum-cell" data-fix="upload" role="button" tabindex="0"><span class="k">자료함<span class="fix">더 넣기</span></span>지식 <b>${S.knowledge}</b>건${conns.length ? ` · ${conns.map((c) => c + ' 연결(읽기)').join(' · ')}` : ''}${S.files.length ? ` · 올린 파일 ${S.files.length}` : ''}</div>
      <div class="sum-cell" data-fix="ai" role="button" tabindex="0"><span class="k">쓰는 AI<span class="fix">바꾸기</span></span>${S.ai === 'Claude' ? `Claude(내 구독) · 오늘 사용 ${S.usage}회` : `${esc(S.ai || '아직 없음')} · 세션은 준비 중`} · 터미널: ${S.terminal === 'yes' ? '노드 연결' : '안 씀'}</div>
      <div class="sum-cell" style="grid-column:1/-1"><span class="k">아직 안 한 것 (리브가 홈에서 다시 권함)</span>${notDone.map(esc).join(' · ')}</div></div>
      <div class="acts"><button type="button" class="btn btn-ghost btn-sm" data-act="keep-summary">이 요약을 자료함에 남기기</button><button type="button" class="btn btn-primary" data-act="go-home">홈으로 가기</button></div>`;
  }

  /* 오른쪽 장부 */
  function renderBuild() {
    if (!buildEl) return;
    const r = S.role, hasRole = !!r;
    const conns = Object.entries(S.conn).filter(([k, v]) => v !== 'off');
    const src = SOURCES.filter((s) => S.sources.includes(s.id) && !s.none);
    const ing = S.ingest;
    const decisions = S.decisions;
    const aiCard = S.ai == null ? `<div class="bc empty"><span class="k">쓰는 AI</span><div class="v"><span class="state off">아직 연결 전</span></div></div>`
      : S.ai === 'Claude' ? (S.aiConnected ? `<div class="bc lit fx" data-fix="ai" role="button" tabindex="0"><span class="k">쓰는 AI<span class="fix">바꾸기</span></span><div class="v"><span class="state on">Claude · 내 구독</span></div><div class="sub">라이블리가 대신 결제하지 않습니다.${S.usage ? ` · 오늘 사용 ${S.usage}회` : ''}</div></div>`
        : `<div class="bc lit fx" data-fix="ai" role="button" tabindex="0"><span class="k">쓰는 AI<span class="fix">바꾸기</span></span><div class="v"><span class="state wait">Claude — 연결 중</span></div><div class="sub">연결되면 내 구독으로 세션이 돕니다. 라이블리가 대신 결제하지 않습니다.</div></div>`)
      : `<div class="bc lit fx" data-fix="ai" role="button" tabindex="0"><span class="k">쓰는 AI<span class="fix">바꾸기</span></span><div class="v"><span class="state wait">${esc(S.ai)} — 세션은 준비 중</span></div><div class="sub">자료 쌓기·정리·열람은 지금부터 됩니다. 준비되면 먼저 알려 드립니다.</div></div>`;
    const tally = ing.tally.length ? `<div class="tally">${ing.tally.map(([n, c]) => `<span class="t">${esc(n)} <b>${c}</b></span>`).join('')}</div>` : '';
    const libCard = !ing.total && !src.length ? `<div class="bc empty"><span class="k">자료함</span><div class="v"><span class="state off">비어 있음 — 자료 단계에서 채웁니다</span></div></div>`
      : ing.finished ? `<div class="bc lit fx" data-fix="upload" role="button" tabindex="0"><span class="k">자료함<span class="fix">더 넣기</span></span><div class="v"><span class="state on">지식 <b>${S.knowledge}</b>건 · 정리 끝</span></div>${tally}${S.knowledge > ing.total ? `<div class="sub">방금 답이 다시 쌓였어요.</div>` : ''}</div>`
      : ing.total ? `<div class="bc lit fx" data-fix="upload" role="button" tabindex="0"><span class="k">자료함<span class="fix">더 넣기</span></span><div class="v"><span class="state busy">${ing.total}개 읽는 중 · ${ing.done}/${ing.total}</span></div><div class="meter"><i style="width:${Math.round(100 * ing.done / ing.total)}%"></i></div>${tally}</div>`
      : `<div class="bc lit fx" data-fix="upload" role="button" tabindex="0"><span class="k">자료함<span class="fix">더 넣기</span></span><div class="v"><span class="state wait">연결한 곳에서 들어올 준비 중</span></div></div>`;
    const connCard = (src.length || conns.length) ? `<div class="bc lit fx" data-fix="sources" role="button" tabindex="0"><span class="k">연결한 것<span class="fix">바꾸기</span></span><div class="v">${src.map((s) => { const st = S.conn[s.id]; const cls = st === 'on' ? 'on' : st === 'busy' ? 'busy' : st === 'later' ? 'wait' : 'off'; const lbl = st === 'on' ? '읽기 · 자동 반영' : st === 'busy' ? '연결 중' : s.live ? '연결 대기' : '노드로 읽기'; return `<div class="state ${cls}">${esc(s.label)} — ${lbl}</div>`; }).join('')}</div>${S.node ? `<div class="sub">내 컴퓨터: 노드 한 줄로 폴더·터미널까지 이어집니다.</div>` : ''}</div>` : '';
    const decCard = decisions.length ? `<div class="bc lit"><span class="k">리브가 정한 것</span><ul>${decisions.map((d, i) => `<li><span>${esc(d)}</span><button class="undo" data-undo="${i}" title="이것만 되돌리기">✕</button></li>`).join('')}</ul><div class="sub">✕를 누르면 그것만 되돌립니다.</div></div>` : '';
    buildEl.innerHTML = `
      <div class="build-h"><b>${livFace(15)}만들어지는 내 워크스페이스</b><span class="k">${S.ob.finished ? '준비 끝' : '실시간'}</span></div>
      ${!hasRole && S.ob.buildProg < 100 ? `<div class="bc"><span class="k">워크스페이스</span><div class="v"><span class="state busy">만드는 중</span></div><div class="meter"><i id="buildMeter" style="width:${S.ob.buildProg}%"></i></div><div class="sub">저장소 만드는 중 · AI 자리 준비 중 · 자료함 비어 있음</div></div>` : ''}
      ${hasRole ? `<div class="bc lit fx" id="bcMe" data-fix="role" role="button" tabindex="0"><span class="k">나<span class="fix">고치기</span></span><div class="v"><b>${esc(r)}</b>${S.jobs.length ? ` · ${S.jobs.map(esc).join(', ')}` : ''}</div><div class="sub">AI가 이 눈높이로 말합니다 · ${r === '개발' ? '기술 설명 자세히' : '비개발 · 쉬운 말'} · 존댓말 · 한국어</div></div>` : `<div class="bc empty"><span class="k">나</span><div class="v">아직 모릅니다 — 지금 여쭙는 것</div></div>`}
      ${aiCard}${libCard}${connCard}${decCard}
      <div class="build-foot">이 뒤에도 리브가 계속 관리합니다. 자료가 새로 생기면 알아서 정리하고, 이상하면 먼저 말을 겁니다.</div>`;
  }
  function flashCard(sel) { const el = buildEl && buildEl.querySelector(sel); if (el) { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); } }
  function startBuildMeter() {
    if (S.ob.buildProg >= 100) return; clearInterval(buildTimer);
    buildTimer = setInterval(() => { S.ob.buildProg = Math.min(100, S.ob.buildProg + 4); const m = $('#buildMeter'); if (m) m.style.width = S.ob.buildProg + '%'; if (S.ob.buildProg >= 100) { clearInterval(buildTimer); save(); renderBuild(); } }, 300);
  }
  function startIngest(total) { Object.assign(S.ingest, { total, done: 0, running: true, finished: false, tally: [] }); save(); renderBuild(); resumeIngest(); }
  function resumeIngest() {
    clearInterval(ingestTimer); if (!S.ingest.running || S.ingest.finished) return;
    const T = pick(TALLY_BY_ROLE, roleOf());
    ingestTimer = setInterval(() => {
      const g = S.ingest; g.done = Math.min(g.total, g.done + 1);
      const p = g.done / g.total; g.tally = T.map(([n, c]) => [n, Math.round(c * p)]).filter(([, c]) => c > 0);
      if (g.done >= g.total) { g.finished = true; g.running = false; g.tally = T.slice(); S.knowledge = Math.max(S.knowledge, g.total); clearInterval(ingestTimer); document.dispatchEvent(new CustomEvent('ingest-done')); }
      save(); renderBuild();
    }, 650);
  }
  /* 오른쪽 장부에서 바로 바꾸기 — 해당 장면으로 이동 */
  panelDelegate();
  function panelDelegate() { document.addEventListener('click', (e) => {
    const un = e.target.closest('.build [data-undo]'); if (un) { const i = +un.dataset.undo; const gone = S.decisions.splice(i, 1); save(); renderBuild(); toast(gone.length ? `되돌렸어요 — ${gone[0]}` : '되돌렸어요.'); return; }
    const b = e.target.closest('.build [data-fix], .stage .summary [data-fix]'); if (!b) return;
    const key = b.dataset.fix; if (S.ob.scene === key) return;
    S.ob.returnTo = S.ob.scene;
    goScene(key, { fix: true });
    toast(S.ob.finished ? '바꾸면 요약에 바로 반영됩니다.' : '바꾸고 나면 하던 자리로 돌아갑니다.');
  }); }
  /* 일지 슬립 — 리브 탭이 같이 쓴다 */
  const slipHTML = (s) => `<div class="slip ${s.st || ''}"><span class="slip-mark">${s.st === 'done' ? '✓' : s.st === 'run' ? '●' : '·'}</span><span class="slip-name">${esc(s.name)}</span>${s.raw ? `<details><summary>자세히</summary><pre>${esc(s.raw)}</pre></details>` : ''}<span class="slip-state">${esc(s.state || (s.st === 'done' ? '했음' : s.st === 'run' ? '하는 중' : ''))}</span></div>`;
  function skipAll() { S.ob.skipped = true; save(); go('#/home'); }
  function copyText(t) { try { navigator.clipboard.writeText(t); toast('복사했어요.'); } catch (e) { toast(t); } }

  /* ═════════════════════════ 앱 셸 ═════════════════════════ */
  /* ── 워크스페이스(노션식): 개인 ↔ 팀. 팀은 동료가 들어오면 생긴다 ── */
  const WS = () => ({ me: { id: 'me', name: `${S.name}의 워크스페이스`, ini: S.name[0], meta: `나만 · 자료 ${S.knowledge}건${S.aiConnected ? ' · Claude 내 구독' : ''}` }, team: { id: 'team', name: '어니스트AI', ini: '어', meta: '2명 · 공유 자료 21건 · 프로젝트 보드' } });
  const curWs = () => (S.ws === 'team' && S.team ? WS().team : WS().me);
  function wsMenuHTML() {
    const w = WS(); const cur = curWs().id;
    const row = (x) => `<button class="ws-row ${cur === x.id ? 'cur' : ''}" data-ws="${x.id}"><span class="ws-ico ${x.id === 'team' ? 'team' : ''}">${esc(x.ini)}</span><span class="ws-txt"><b>${esc(x.name)}</b><small>${esc(x.meta)}</small></span>${cur === x.id ? ic('check', 'ic-sm') : ''}</button>`;
    return `<div class="ws-acc">lively1@honestai.tech</div>
      <div class="ws-sec">개인</div>${row(w.me)}
      <div class="ws-sec">팀</div>${S.team ? row(w.team) : `<div class="ws-row ghost"><span class="ws-ico ghost">+</span><span class="ws-txt"><b>아직 팀 워크스페이스가 없어요</b><small>동료를 초대하면 여기 생깁니다 — 초대장 ${S.invitesLeft}장</small></span></div>`}
      <button class="ws-row add" data-act="ws-new">${ic('plus', 'ic-sm')} 팀 워크스페이스 만들기</button>
      <button class="ws-row add" data-act="ws-join">${ic('link', 'ic-sm')} 초대 링크로 참여</button>
      <div class="ws-hr"></div>
      <button class="ws-row add">설정</button><button class="ws-row add">로그아웃</button>`;
  }
  function renderApp(app, h) {
    let tab = h.startsWith('#/library') ? 'library' : h.startsWith('#/work') ? 'work' : h.startsWith('#/liv') ? 'liv' : h.startsWith('#/board') ? 'board' : 'home';
    const teamWs = curWs().id === 'team'; if (tab === 'board' && !teamWs) tab = 'home';
    const wait = S.work.filter((w) => w.st === 'wait').length, running = S.work.filter((w) => w.st === 'busy' || w.st === 'wait').length;
    const livWait = livCards().some((c) => c.p0);
    const w = curWs();
    app.innerHTML = `<div class="app">
      <header class="topbar"><a class="wordmark" href="#/home">Lively <i class="pulse-dot"></i></a>
        <div class="ws"><button class="ws-btn" data-act="ws" aria-haspopup="menu" aria-expanded="false"><span class="ws-ico ${teamWs ? 'team' : ''}">${esc(w.ini)}</span><span class="ws-name">${esc(w.name)}</span>${ic('chev', 'ic-sm')}</button><div class="ws-menu" id="wsMenu" hidden>${wsMenuHTML()}</div></div>
        <nav class="tabs" aria-label="주 메뉴">
          <a href="#/home" class="${tab === 'home' ? 'active' : ''}">홈</a>
          <a href="#/library" class="${tab === 'library' ? 'active' : ''}">자료함 <span class="n">${teamWs ? 21 : S.knowledge}</span></a>
          <a href="#/work" class="${tab === 'work' ? 'active' : ''}">진행 중인 일 ${running ? `<span class="n">${running}</span>` : ''}</a>
          ${teamWs ? `<a href="#/board" class="${tab === 'board' ? 'active' : ''}">프로젝트 ${S.boardOn ? '' : '<span class="newmark">새로</span>'}</a>` : ''}
          <a href="#/liv" class="${tab === 'liv' ? 'active' : ''}">리브 <span class="livdot ${livWait ? 'wait' : ''}"></span></a>
        </nav>
        <div class="topbar-right"><span class="util beta">베타 · 무료</span><button class="util invite" data-act="invite">${teamWs ? '팀원 초대' : `초대 ${S.invitesLeft}장`}</button><span class="util"><span class="ava">${esc(S.name[0])}</span>${teamWs ? `<span class="ava ava2">김</span>` : ''}${esc(S.name)}${teamWs ? ' · 김민수' : ''}</span></div>
      </header>
      ${teamWs ? `<div class="ws-bar"><span class="ws-ico team sm">어</span><b>어니스트AI</b> · 팀 워크스페이스 — 여기 올린 자료와 결과는 팀원 모두가 봅니다. 개인 자료는 <button class="btn-text" data-ws="me">내 워크스페이스</button>에 그대로 있어요.</div>` : ''}
      <main class="page" id="page"></main></div>`;
    const page = $('#page');
    ({ home: renderHome, library: renderLibrary, work: renderWork, liv: renderLiv, board: renderBoard })[tab](page);
    $$('[data-act="invite"]').forEach((b) => b.addEventListener('click', inviteLink));
    const wsBtn = $('[data-act="ws"]'), menu = $('#wsMenu');
    wsBtn.addEventListener('click', (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; wsBtn.setAttribute('aria-expanded', String(!menu.hidden)); });
    document.addEventListener('click', (e) => { if (!menu.hidden && !e.target.closest('.ws')) { menu.hidden = true; wsBtn.setAttribute('aria-expanded', 'false'); } });
    $$('[data-ws]').forEach((b) => b.addEventListener('click', () => switchWs(b.dataset.ws)));
    $$('[data-act="ws-new"]').forEach((b) => b.addEventListener('click', () => { if (!S.team) { S.team = true; S.boardOn = false; S.invitesLeft = 2; if (S.day < 2) seedDay2(); } S.ws = 'me'; switchWs('team'); toast('어니스트AI 워크스페이스를 만들었어요. 초대 링크는 오른쪽 위 [팀원 초대]에 있어요.'); }));
    $$('[data-act="ws-join"]').forEach((b) => b.addEventListener('click', () => toast('초대 링크를 붙여 넣으면 그 팀 워크스페이스가 목록에 생깁니다(프로토타입).')));
  }
  function switchWs(id) { if (id === 'team' && !S.team) return; if (S.ws === id) return; S.ws = id; save(); if (location.hash.startsWith('#/board') && id !== 'team') go('#/home'); render(); toast(id === 'team' ? '어니스트AI로 이동했어요 — 여기 올린 것은 팀원 모두가 봅니다.' : '내 워크스페이스로 돌아왔어요.'); }
  function inviteLink() { copyText('https://app.lvly.io/join/lvi-8f2k-q7m3-xn1p'); toast('초대 링크를 복사했어요. 동료가 들어오면 팀의 기억이 됩니다.'); }

  /* 리브 카드(홈 레일·리브 탭 공용) — 상태 변화 있을 때만, 거절한 것은 다시 안 꺼낸다 */
  function livCards() {
    const c = [];
    if (S.ob.skipped && !S.ob.finished) c.push({ id: 'resume', p0: true, t: '처음 설정 이어서 하기', d: `${S.ob.doneSteps.length}/5 끝났어요. 남은 ${5 - S.ob.doneSteps.length}단계는 2분이면 됩니다.`, ok: '이어서 하기', go: '#/welcome' });
    if (S.ai === 'Claude' && !S.aiConnected) c.push({ id: 'claude', p0: true, t: 'Claude 계정 연결', d: '연결해야 답이 내 구독으로 돕니다. 1분이면 됩니다.', ok: '연결하기', go: '#/welcome' });
    if (S.ai && S.ai !== 'Claude' && !S.livDismissed.includes('noclaude')) c.push({ id: 'noclaude', p0: false, t: S.ai === '아직 없어요' ? '세션은 Claude 연결 후' : `${S.ai} 세션은 준비 중`, d: '자료 쌓기·정리·검색은 지금부터 됩니다. 준비되면 먼저 알려 드릴게요.', ok: '알림 받기' });
    if (S.conn.notion !== 'on' && !S.declined.includes('notion') && !S.livDismissed.includes('notion')) c.push({ id: 'notion', p0: false, t: '노션 연결', d: '회의록이 노션에 더 있는 것 같아요. 연결하면 다음 답부터 그것도 봅니다.', ok: '연결하기' });
    if (S.day >= 2 && !S.livDismissed.includes('invite') && !S.team) c.push({ id: 'invite', p0: false, t: '동료 초대', d: '동료를 부르면 팀의 기억이 됩니다. 초대받은 사람은 AI 구독이 없어도 보고 쓸 수 있어요.', ok: '초대 링크 복사' });
    if (S.team && S.ws !== 'team' && !S.livDismissed.includes('board')) c.push({ id: 'board', p0: true, t: '김민수님이 들어왔어요', d: '어니스트AI 팀 워크스페이스가 생겼어요. 거기서 프로젝트 보드로 맡은 일을 나눠 볼 수 있어요. 개인 자료는 여기 그대로예요.', ok: '가 보기', later: '아직' });
    if (S.day >= 2 && !S.livDismissed.includes('weekly')) c.push({ id: 'weekly', p0: false, t: '매주 회의 요약', d: '월요일 아침마다 지난주 회의 결정을 모아 둘까요?', ok: '켜기' });
    if (S.node === false && S.terminal === 'yes' && !S.livDismissed.includes('node')) c.push({ id: 'node', p0: false, t: '내 컴퓨터 연결', d: '한 줄만 실행하면 터미널의 Claude Code에도 같은 자료가 실립니다.', ok: '명령 복사' });
    return c.sort((a, b) => (b.p0 ? 1 : 0) - (a.p0 ? 1 : 0));
  }
  function livCardAct(id, later) {
    if (later) { S.livDismissed.push(id); if (['notion', 'invite', 'weekly', 'node'].includes(id)) S.declined.push(id); save(); return render(); }
    if (id === 'resume' || id === 'claude') return go('#/welcome');
    if (id === 'notion') { S.conn.notion = 'busy'; save(); render(); toast('새 탭에서 노션 허용을 기다리는 중…'); setTimeout(() => { S.conn.notion = 'on'; S.knowledge += 18; S.library.push({ t: '노션 회의록 18건', src: 'notion' }); save(); render(); toast('노션을 연결했어요. 회의록 18개가 자료함에 들어왔습니다.'); }, 1400); return; }
    if (id === 'invite') return inviteLink();
    if (id === 'board') { S.boardOn = true; S.livDismissed.push('board'); S.ws = 'team'; save(); go('#/board'); return; }
    if (id === 'weekly') { S.livDismissed.push('weekly'); S.work.push({ id: 'weekly', t: '매주 월요일 · 지난주 회의 결정 모으기', st: 'sched', when: '매주', m: '자동 · 월요일 08:00' }); save(); render(); toast('켰어요. 월요일 아침에 첫 결과가 옵니다.'); return; }
    if (id === 'node') { copyText('lively node --daemon'); return; }
    if (id === 'noclaude') { S.livDismissed.push('noclaude'); save(); render(); toast('준비되면 먼저 알려 드릴게요.'); }
  }
  const livCardHTML = (c, cls) => `<div class="rc liv ${cls || ''}" data-card="${c.id}"><span class="k">${livFace(14)}리브 · 지금 하나</span><div class="v"><b>${esc(c.t)}</b> — ${esc(c.d)}</div><div class="acts"><button class="btn btn-mint btn-sm" data-liv-ok="${c.id}">${esc(c.ok)}</button><button class="btn btn-ghost btn-sm" data-liv-later="${c.id}">${esc(c.later || '나중에')}</button></div></div>`;
  function bindLivCards(root) { $$('[data-liv-ok]', root).forEach((b) => b.addEventListener('click', () => livCardAct(b.dataset.livOk, false))); $$('[data-liv-later]', root).forEach((b) => b.addEventListener('click', () => livCardAct(b.dataset.livLater, true))); }

  /* ═════════════════════════ 홈 ═════════════════════════ */
  function seedDay2() {
    if (S.day >= 2) return; S.day = 2;
    S.knowledge += 3;
    S.work.unshift({ id: 'w1', t: '8월 캠페인 회고 초안', st: 'busy', when: '2분 전', m: '읽은 것: 캠페인 시트 3 · 7월 회고 메모 — 지금 초안 2절 쓰는 중', started: Date.now() });
    S.work.unshift({ id: 'w2', t: '회의 3건 결정 모으기', st: 'wait', when: '5분 전', q: '회의록 8/5는 초안인데 포함할까요?', opts: ['포함', '빼기'] });
    S.library.unshift({ t: '8/14 주간회의 — 결정 2 · 할 일 3', src: 'gdrive', when: '12분 전', by: '리브가 정리함' }, { t: '8월 캠페인 회고 초안', src: 'ai', when: '1시간 전' }, { t: '가격 정책 8월 — 7월 것과 겹쳐요', src: 'gdrive', when: '2시간 전', dup: true });
    save();
  }
  /* 홈 우측 — 내 자료함(실시간): 무엇이 어디서 들어와 어떻게 정리되는지 한눈에 */
  function libFeed() {
    const T = S.ingest.tally.length ? S.ingest.tally : pick(TALLY_BY_ROLE, roleOf());
    const f = [];
    if (S.conn.notion === 'on') f.push({ when: '12분 전', src: '노션', to: T[0][0], t: `"8/14 주간회의" — 리브가 결정 2·할 일 3 뽑아 둠`, k: 'notion' });
    if (S.conn.gdrive === 'on') f.push({ when: S.conn.notion === 'on' ? '1시간 전' : '12분 전', src: '드라이브', to: T[0][0], t: `새 파일 ${S.day >= 2 ? 3 : 1}건 → 갈래 배정`, k: 'gdrive' });
    if (S.day >= 2) f.push({ when: '2시간 전', src: '정리', to: '확인 필요', t: '가격 정책 8월·7월이 겹쳐요', k: 'dup' });
    if (S.knowledge > S.ingest.total) f.push({ when: '방금', src: '내 AI', to: 'AI와 만든 것', t: `답 ${S.knowledge - S.ingest.total}건이 다시 쌓임`, k: 'ai' });
    if (!f.length) f.push({ when: '—', src: '아직 조용', to: '', t: '연결하거나 올리면 여기 흐름이 보여요', k: 'none' });
    return f.slice(0, 3);
  }
  function libLiveCardHTML(kn) {
    const T = S.ingest.tally.length ? S.ingest.tally : pick(TALLY_BY_ROLE, roleOf());
    const live = S.conn.gdrive === 'on' || S.conn.notion === 'on';
    const feed = libFeed();
    return `<div class="rc rc-link lib-live" role="link" tabindex="0" title="자료함 열기">
      <span class="k">${S.team ? '우리 자료함' : '내 자료함'} ${live ? '<span class="live-dot">자동 반영 중</span>' : ''}<span class="go">열기 →</span></span>
      <div class="big">지식 ${kn}<small>건</small>${S.day >= 2 ? `<small class="delta">오늘 +${S.team ? 21 : 3}</small>` : ''}</div>
      <div class="tally-row">${T.map(([n, c]) => `<button type="button" class="t" data-go-lib="${esc(n)}">${esc(n)} <b>${c}</b></button>`).join('')}</div>
      <ul class="feed">${feed.map((x) => `<li class="${x.k}"><time>${esc(x.when)}</time><span class="fl"><b>${esc(x.src)}</b>${x.to ? ` → ${esc(x.to)}` : ''} · ${esc(x.t)}</span></li>`).join('')}</ul>
      <div class="meter mint"><i style="width:${Math.min(100, Math.round(kn / 5))}%"></i></div>
      <div class="sub">저장 ${S.team ? '0.7' : '0.4'} / 5 GB · ${live ? `${[S.conn.gdrive === 'on' && '드라이브', S.conn.notion === 'on' && '노션'].filter(Boolean).join('·')} 새 자료는 알아서 들어와요` : '<button type="button" class="btn-text k-link" data-go-src="add">연결하면 알아서 들어옵니다 →</button>'}</div>
    </div>`;
  }
  function renderHome(page) {
    const r = roleOf(); const hour = new Date().getHours(); const hi = hour < 11 ? '좋은 아침이에요' : hour < 18 ? '좋은 오후예요' : '좋은 저녁이에요';
    const lead = S.ob.finished ? (S.day >= 2 ? '어제 회의부터 물어보세요.' : '이제 무엇이든 시켜보세요.') : (S.ob.skipped ? '처음 설정을 이어서 하면 답이 더 정확해집니다.' : '');
    const kn = S.knowledge + (S.team ? 21 : 0);
    const sugs = pick(SUGS_BY_ROLE, r);
    const running = S.work.filter((w) => ['busy', 'wait'].includes(w.st));
    const recent = S.work.filter((w) => w.st === 'done').slice(0, 3);
    const cards = livCards(); const card = cards[0];
    const teamRows = S.team ? [{ t: '김: 계약서 조항 대조', st: 'busy', m: '작업 중 · 6분 전 · 읽은 것: 표준 계약서 v4' }] : [];
    page.innerHTML = `<div class="home">
      <div class="hi"><h1>${hi}, ${esc(S.name)}님. ${esc(lead)}</h1><span class="date">${dateStr()}</span></div>
      <div class="home-main">
        <div class="composer" id="composer">
          <textarea id="homeIn" placeholder="${S.aiConnected ? `무엇이든 시켜보세요 — ${S.team ? '우리' : '내'} 자료 ${kn}건을 알고 답합니다` : (S.ai && S.ai !== 'Claude') ? `자료 정리·검색은 지금 됩니다 — 세션은 Claude 연결 후 · 체험 ${S.ob.freeLeft}회 남음` : 'Claude를 연결하면 내 자료를 알고 답합니다 — 리브가 안내해요'}"></textarea>
          <div class="composer-bar"><button class="tool">${ic('clip')} 파일</button><button class="tool">${S.ai === 'Claude' ? 'Claude' : (S.ai || 'AI')} ${ic('chev', 'ic-sm')}</button>${S.terminal === 'yes' ? `<button class="tool">${ic('term')} 터미널로 열기</button>` : ''}<span class="cap">동시 ${running.length}/3</span><button class="btn btn-primary btn-sm send" id="homeSend">보내기</button></div>
        </div>
        <div class="sugs"><span class="k">이런 걸 시켜보세요</span>${sugs.map(([k, s]) => `<button class="sug" data-sug="${esc(s)}"><span class="kind">${esc(k)}</span>${esc(s)}</button>`).join('')}</div>
        <section class="zone"><div class="zone-h"><h4>진행 중인 일</h4><span class="n">${running.length + teamRows.length}</span><a class="btn-text sp" href="#/work">전체 보기 →</a></div>
          <div class="zone-b" id="homeWork">${(running.length + teamRows.length) ? running.map(workRowHTML).join('') + teamRows.map(workRowHTML).join('') : `<div class="note-dash" style="margin:4px 6px 6px">맡겨 둔 일이 없어요. 위 창에서 시키면 여기서 진행을 봅니다 — 작업 중 · 확인 필요 · 끝남.</div>`}</div></section>
        ${S.team ? `<section class="zone"><div class="zone-h"><h4>팀이 오늘 쌓은 것</h4><span class="n">21</span></div><div class="recent"><span class="state on">김이 올린 계약서 v4 · 1시간 전</span><span class="state on">리브가 정리한 8/14 회의 · 12분 전</span><span class="state on">김: 위약금 조항 정리 · 3시간 전</span></div></section>` : ''}
        <section class="zone"><div class="zone-h"><h4>최근</h4></div><div class="recent">${recent.length ? recent.map((w) => `<span class="state on">${esc(w.t)} · ${esc(w.when)}</span>`).join('') : `<span class="muted">아직 없어요.</span>`}<a class="btn-text" href="#/work" style="margin-left:auto">전체 보기 →</a></div></section>
      </div>
      <aside class="rail">
        ${libLiveCardHTML(kn)}
        ${card ? livCardHTML(card) : `<div class="rc liv"><span class="k">${livFace(14)}리브</span><div class="v">지금 손볼 것이 없어요. 자료가 새로 생기면 알아서 정리하고, 이상하면 먼저 말을 걸게요.</div><div class="sub" style="margin-top:6px">오늘 한 일 · 아침 점검 · 새 자료 ${S.day >= 2 ? 3 : 0}건 갈래 배정${S.day >= 2 ? ' · 겹침 1쌍 발견' : ''}</div><div class="acts"><a class="btn btn-ghost btn-sm" href="#/liv">리브에게 부탁하기</a><a class="btn-text" href="#/liv" data-liv-view="wiki">리브가 만든 지식 →</a></div></div>`}
        <div class="rc"><span class="k">같이 쓰기</span><div class="v" style="font-size:13.5px">동료를 부르면 팀의 기억이 됩니다.${S.team ? ' 구성원: 윤(나) · 김 — 구독 없이 열람·편집 중' : ''}</div><div class="acts"><button class="btn btn-ghost btn-sm" data-act="invite2">${ic('link', 'ic-sm')} 초대 링크 복사</button>${S.team ? `<button class="btn-text" data-ws="team">어니스트AI 열기 →</button>` : `<span class="muted num" style="font-size:12.5px;align-self:center">${S.invitesLeft}장 남음</span>`}</div></div>
        <div class="rc usage-c"><span class="k">이번 달 사용 <button class="btn-text k-link" data-act="usage">자세히 →</button></span><div class="usage"><span>세션</span><b>${S.day >= 2 ? '4시간' : '0.2시간'} / 120</b><span>동시 세션</span><b>${running.length} / 3</b><span>Claude 사용</span><b>${S.usage}회 <button class="btn-text k-link" data-ask-liv="이번 달 Claude 사용량 얼마나 돼?">리브에게 묻기</button></b></div><div class="fine">베타 무료 · 정식 출시 후 유료 플랜으로 바뀝니다(정가 상당액 표기 예정). 쓰던 AI 구독은 그대로 필요합니다. <button class="btn-text k-link" data-act="plan">플랜 안내 →</button></div></div>
      </aside></div>`;
    bindLivCards(page); $$('[data-act="invite2"]', page).forEach((b) => b.addEventListener('click', inviteLink));
    $$('[data-ws]', page).forEach((b) => b.addEventListener('click', () => switchWs(b.dataset.ws)));
    $$('[data-liv-view]', page).forEach((b) => b.addEventListener('click', () => { S.livView = b.dataset.livView; save(); }));
    $$('[data-ask-liv]', page).forEach((b) => b.addEventListener('click', () => { S.livView = 'chat'; S.livLog = S.livLog || []; S.livLog.push({ me: b.dataset.askLiv }); S.livLog.push(livReply(b.dataset.askLiv)); save(); go('#/liv'); }));
    $$('[data-act="usage"]', page).forEach((b) => b.addEventListener('click', () => toast('사용량 상세는 프로필 › 사용량에서 봅니다(프로토타입).')));
    $$('[data-act="plan"]', page).forEach((b) => b.addEventListener('click', () => toast('정식 출시 때 플랜과 정가 상당액을 여기서 안내합니다(프로토타입).')));
    $$('[data-go-lib]', page).forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); S.libFilter = b.dataset.goLib; S.libSrc = 'all'; save(); go('#/library'); }));
    $$('[data-go-src]', page).forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); S.libSrc = b.dataset.goSrc; S.libFilter = 'all'; save(); go('#/library'); }));
    const lc = $('.lib-live', page); if (lc) lc.addEventListener('click', (e) => { if (e.target.closest('button,a')) return; S.libFilter = 'all'; S.libSrc = 'all'; save(); go('#/library'); });
    $$('[data-sug]', page).forEach((b) => b.addEventListener('click', () => { const t = $('#homeIn'); t.value = b.dataset.sug; t.focus(); }));
    if (S.homePrefill) { const t = $('#homeIn'); t.value = S.homePrefill; S.homePrefill = null; save(); setTimeout(() => { t.focus(); t.setSelectionRange(t.value.length, t.value.length); }, 60); }
    const send = () => { const t = $('#homeIn'); const v = t.value.trim(); if (!v) return; if (!S.aiConnected && S.ai !== 'Claude' && S.ob.freeLeft <= 0) { toast('체험 3회를 다 썼어요. Claude를 연결하면 계속 쓸 수 있습니다.'); return; } if (S.work.filter((w) => w.st === 'busy').length >= 3) { toast('동시에 3개까지 맡길 수 있어요. 하나가 끝나면 이어서 시켜 주세요.'); return; } t.value = ''; const id = 'w' + Date.now(); S.work.unshift({ id, t: v.length > 34 ? v.slice(0, 34) + '…' : v, st: 'busy', when: '방금', m: '읽은 것 고르는 중 · Claude', started: Date.now() }); S.usage += 1; if (!S.aiConnected && S.ai !== 'Claude') S.ob.freeLeft--; save(); render(); setTimeout(() => { const w = S.work.find((x) => x.id === id); if (w && w.st === 'busy') { w.st = 'done'; w.when = '방금'; w.m = '결과 → 자료함'; S.knowledge += 1; save(); if (location.hash.startsWith('#/home') || location.hash.startsWith('#/work')) render(); toast('끝났어요. 결과를 자료함에 남겼습니다.'); } }, 7000); };
    $('#homeSend').addEventListener('click', send); $('#homeIn').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } });
    bindWorkRows(page);
  }
  function workRowHTML(w) {
    const st = w.st === 'busy' ? '<span class="state busy">작업 중</span>' : w.st === 'wait' ? '<span class="state wait">확인 필요</span>' : w.st === 'sched' ? '<span class="state off">매주</span>' : '<span class="state on">끝남</span>';
    return `<div class="work-row ${w.st === 'wait' ? 'wait' : ''}" data-w="${w.id}"><div class="grow"><div class="t">${esc(w.t)}</div><div class="m">${st} · ${esc(w.when || '')}${w.m ? ` · ${esc(w.m)}` : ''}</div>${w.q ? `<div class="q">"${esc(w.q)}" ${(w.opts || []).map((o) => `<button class="chip" data-answer="${esc(o)}">${esc(o)}</button>`).join('')}</div>` : ''}</div>
      <div class="r">${w.st === 'wait' ? `<a class="btn btn-ghost btn-sm" href="#/work">대화 열기</a>` : w.st === 'busy' ? `<a class="btn btn-ghost btn-sm" href="#/work">열기</a>` : w.st === 'done' ? `<a class="btn btn-ghost btn-sm" href="#/library">결과 보기</a><button class="btn btn-ghost btn-sm" data-again="${w.id}">이어서</button>` : `<button class="btn btn-ghost btn-sm" data-off="${w.id}">끄기</button>`}</div></div>`;
  }
  function bindWorkRows(root) {
    $$('[data-answer]', root).forEach((b) => b.addEventListener('click', () => { const row = b.closest('[data-w]'); const w = S.work.find((x) => x.id === row.dataset.w); if (!w) return; w.st = 'busy'; w.q = null; w.m = `답: ${b.dataset.answer} · 이어서 작업 중`; w.started = Date.now(); save(); render(); setTimeout(() => { w.st = 'done'; w.m = '결과 → 자료함'; w.when = '방금'; S.knowledge += 1; save(); if (!location.hash.startsWith('#/welcome')) render(); toast(`"${w.t}" 끝났어요.`); }, 6000); }));
    $$('[data-again]', root).forEach((b) => b.addEventListener('click', () => { const t = $('#homeIn'); if (t) { t.value = '이어서 — '; t.focus(); } else go('#/home'); }));
    $$('[data-off]', root).forEach((b) => b.addEventListener('click', () => { S.work = S.work.filter((x) => x.id !== b.dataset.off); save(); render(); toast('껐어요.'); }));
  }

  /* ═════════════════════════ 자료함 ═════════════════════════ */
  function renderLibrary(page) {
    const T = S.ingest.tally.length ? S.ingest.tally : pick(TALLY_BY_ROLE, roleOf());
    const kn = S.knowledge + (S.team ? 21 : 0);
    const cur = S.libFilter || 'all'; const src = S.libSrc || 'all';
    const CAT = { default: [['8/12 팀 회의', '회의록', 'm4a', '1일 전'], ['8/5 팀 회의(초안)', '회의록', 'docx', '8일 전'], ['7/30 킥오프', '회의록', 'm4a', '2주 전'], ['7월 월간 보고서', '보고서', 'pptx', '2주 전'], ['6월 월간 보고서', '보고서', 'pptx', '6주 전'], ['캠페인 성과 시트', '보고서', 'xlsx', '3일 전'], ['가격 정책 v3', '정책·계약', 'docx', '3일 전'], ['가격 정책(7월)', '정책·계약', 'docx', '3주 전'], ['환불 기준 안내', '정책·계약', 'docx', '5일 전']] };
    const cat = ['연구·대학원', '법무·계약', '개발'].includes(roleOf()) ? null : CAT.default;
    const docs = [];
    const files = pick(FILES_BY_ROLE, roleOf());
    if (cat) { cat.forEach(([t, g, ext, when], i) => docs.push({ t, g, ext, when, src: i % 2 === 0 && S.conn.gdrive === 'on' ? 'gdrive' : 'file' })); }
    else { T.forEach(([n, c], gi) => { for (let i = 0; i < Math.min(c, 3); i++) { const f = files[(gi * 3 + i) % files.length]; docs.push({ t: f.replace(/\.[a-z0-9]+$/i, ''), g: n, src: i % 3 === 0 && S.conn.gdrive === 'on' ? 'gdrive' : 'file', when: `${gi + i + 1}일 전`, ext: f.split('.').pop() }); } }); }
    const today = S.library.length ? S.library : [];
    docs.forEach((d, i) => { const pool = ['file'].concat(S.conn.gdrive === 'on' ? ['gdrive'] : [], S.conn.notion === 'on' ? ['notion'] : []); d.src = pool[i % pool.length]; if (i >= docs.length - Math.min(2, docs.length) && S.knowledge > S.ingest.total) d.src = 'ai'; });
    const SRC_LBL = { gdrive: '구글 드라이브', notion: '노션', file: '올린 파일', ai: 'AI와 만든 것', node: '내 컴퓨터' };
    const list = docs.filter((d) => (cur === 'all' || d.g === cur) && (src === 'all' || d.src === src));
    const q = (S.libQ || '').trim();
    const shown = q ? list.filter((d) => d.t.includes(q)) : list;
    const CONNECTORS = [
      { id: 'notion', label: '노션', logo: 'N', brings: '페이지·회의록', how: '허용 한 번' },
      { id: 'gdrive', label: '구글 드라이브', logo: 'D', brings: '폴더의 문서·시트', how: '허용 한 번' },
      { id: 'slack', label: '슬랙', logo: 'S', brings: '채널 대화·결정', how: '리브가 안내', soon: true },
      { id: 'gmail', label: '지메일', logo: 'M', brings: '메일·첨부', how: '허용 한 번', soon: true },
      { id: 'clickup', label: '클릭업', logo: 'C', brings: '할 일·프로젝트', how: '리브가 안내', soon: true },
      { id: 'node', label: '내 컴퓨터 폴더', logo: ic('term', 'ic-sm'), brings: '로컬 폴더·터미널', how: '한 줄 설치', node: true },
    ];
    const connected = CONNECTORS.filter((c) => (c.node ? S.node : S.conn[c.id] === 'on'));
    const more = CONNECTORS.filter((c) => !(c.node ? S.node : S.conn[c.id] === 'on'));
    const cnt = { gdrive: 31, notion: 18, node: 12 };
    const srcRow = (id, label, n, meta, dot) => `<button class="navi src ${src === id ? 'on' : ''}" data-src="${id}"><span class="dot ${dot || ''}"></span><span class="lbl">${label}${meta ? `<small>${meta}</small>` : ''}</span><span class="n">${n}</span></button>`;
    page.innerHTML = `<div class="page-head"><h1>자료함</h1><span class="sub num">지식 ${kn}건 · 갈래 ${T.length}${connected.length ? ` · 연결 ${connected.length}` : ''}</span><div class="acts"><button class="btn btn-ghost btn-sm">${ic('plus', 'ic-sm')} 새 메모</button><button class="btn btn-ghost btn-sm">${ic('up', 'ic-sm')} 파일 올리기</button></div></div>
    <div class="lib"><nav class="lib-nav">
      <div class="lib-live-line"><span class="live-dot">리브가 정리 중</span><span>마지막 정리 1시간 전 · 새 자료는 갈래에 알아서 들어가요</span> <a href="#/liv" data-liv-view="wiki">규칙 보기 →</a></div>
      <div class="rc"><span class="k">갈래 <small class="k-sub">눌러서 거르기</small></span><button class="navi ${cur === 'all' && src === 'all' ? 'on' : ''}" data-f="all">전체 <span class="n">${kn}</span></button>${T.map(([n, c]) => `<button class="navi ${cur === n ? 'on' : ''}" data-f="${esc(n)}">${esc(n)} <span class="n">${c}</span></button>`).join('')}
        ${S.libSuggestOpen ? `<div class="liv-suggest"><span class="k">${livFace(13)}리브 제안</span><b>'고객 미팅' 갈래</b><small>${T[0][0]} ${T[0][1]}건 중 3건이 고객사 이름이라 따로 두면 찾기 쉬워요.</small><div class="acts"><button class="btn btn-mint btn-xs" data-suggest="ok">추가</button><button class="btn btn-ghost btn-xs" data-suggest="no">아니요</button></div></div>` : `<button class="navi muted add-cat" data-suggest="open">${ic('plus', 'ic-sm')} 갈래 추가 · 리브가 제안 1</button>`}</div>
      <div class="rc"><span class="k">연결한 곳 <small class="k-sub">새 자료가 계속 따라와요</small></span>
        ${connected.map((c) => srcRow(c.id, c.label, cnt[c.id] || 0, `자동 반영 · ${c.id === 'notion' ? '12분 전' : '1시간 전'}`, 'on')).join('')}
        ${srcRow('file', '올린 파일', S.files.length ? 10 : 0, '', 'off')}
        ${srcRow('ai', 'AI와 만든 것', Math.max(0, S.knowledge - S.ingest.total), '', 'off')}
        <div class="more-h">더 연결하기</div>
        ${more.map((c) => `<button class="navi conn-add ${S.conn[c.id] === 'busy' ? 'is-busy' : ''}" data-conn-add="${c.id}"><span class="logo">${c.logo}</span><span class="lbl">${esc(c.label)}<small>${esc(c.brings)} · ${esc(c.how)}</small></span><span class="n">${c.soon ? '안내' : c.node ? '설치' : '연결'}</span></button>`).join('')}
        <a class="navi muted" href="#/liv" style="font-weight:500">${ic('plus', 'ic-sm')} 다른 것도 — 리브에게 물어보기</a></div>
      <div class="rc"><span class="k">원본 파일</span><button class="navi">${ic('folder', 'ic-sm')} ${S.files.length || 0}개 · 폴더 보기</button></div></nav>
    <div class="lib-main">
      <div class="search">${ic('search')}<input id="libQ" type="search" placeholder="무엇이든 검색 — 의미로 찾습니다" value="${esc(S.libQ || '')}"><span class="kbd">⌘K</span></div>
      ${today.length ? `<section class="zone"><div class="zone-h"><h4>오늘 들어온 것</h4><span class="n">${today.length}</span></div>${today.map((d) => `<div class="doc ${d.dup ? 'dup' : ''}"><span class="ico">${ic(d.src === 'ai' ? 'doc' : 'folder')}</span><div class="grow"><div class="t">${esc(d.t)}</div><div class="m"><span class="state ${d.dup ? 'wait' : 'on'}">${d.src === 'gdrive' ? '구글 드라이브' : d.src === 'notion' ? '노션' : 'AI와 만든 것'}</span> · ${esc(d.when || '방금')}${d.by ? ` · ${esc(d.by)}` : ''}</div></div>${d.dup ? `<div class="r"><button class="chip" data-dup="new">8월을 최신으로</button><button class="chip" data-dup="both">둘 다</button></div>` : ''}</div>`).join('')}</section>` : `<div class="note-dash">오늘 들어온 것이 아직 없어요. ${S.conn.gdrive === 'on' ? '드라이브에 새 파일이 생기면 여기 먼저 보입니다.' : '연결하거나 올리면 여기 먼저 보입니다.'}</div>`}
      <section class="zone"><div class="zone-h"><h4>${cur === 'all' ? (src === 'all' ? '전체' : esc(SRC_LBL[src] || src)) : esc(cur)}</h4><span class="n">${shown.length}</span>${q ? `<span class="muted" style="font-size:12.5px">"${esc(q)}" 검색</span>` : ''}</div>${shown.length ? shown.map((d) => `<div class="doc"><span class="ico">${ic(d.ext === 'm4a' ? 'mic' : d.ext === 'xlsx' ? 'sheet' : 'doc')}</span><div class="grow"><div class="t">${esc(d.t)}</div><div class="m">${esc(d.g)} · ${SRC_LBL[d.src] || '올린 파일'} · ${esc(d.when)}</div></div><div class="r"><span class="tag">${esc(d.ext)}</span></div></div>`).join('') : `<div class="note-dash" style="margin:8px">찾는 것이 없어요. 다른 말로 물어보거나, 시키는 창에서 "찾아 줘"라고 해도 됩니다.</div>`}</section>
    </div></div>`;
    $$('[data-f]', page).forEach((b) => b.addEventListener('click', () => { S.libFilter = b.dataset.f; S.libSrc = 'all'; save(); renderLibrary(page); }));
    $$('[data-src]', page).forEach((b) => b.addEventListener('click', () => { S.libSrc = S.libSrc === b.dataset.src ? 'all' : b.dataset.src; S.libFilter = 'all'; save(); renderLibrary(page); }));
    $$('[data-suggest]', page).forEach((b) => b.addEventListener('click', () => { const a = b.dataset.suggest; if (a === 'open') S.libSuggestOpen = true; else { S.libSuggestOpen = false; if (a === 'ok') { const T2 = S.ingest.tally.length ? S.ingest.tally : (S.ingest.tally = pick(TALLY_BY_ROLE, roleOf()).slice()); if (!T2.find((t) => t[0] === '고객 미팅')) { T2[0][1] -= 3; T2.push(['고객 미팅', 3]); } S.decisions.push("갈래 추가: '고객 미팅'"); toast("'고객 미팅' 갈래를 만들고 3건을 옮겼어요. 새 자료도 이 갈래로 들어갑니다."); } } save(); renderLibrary(page); }));
    $$('[data-conn-add]', page).forEach((b) => b.addEventListener('click', () => { const id = b.dataset.connAdd; const c = CONNECTORS.find((x) => x.id === id);
      if (c.node) { copyText('lively node --daemon'); S.node = true; S.decisions.push('내 컴퓨터 노드 연결'); save(); renderLibrary(page); toast('명령을 복사했어요. 터미널에서 실행하면 그 폴더를 리브가 읽어요.'); return; }
      if (c.soon) { S.livLog = S.livLog || []; S.livLog.push({ me: `${c.label} 연결해 줘` }); S.livLog.push({ liv: `${c.label}은 앱 발급이 한 번 필요해서 제가 한 걸음씩 안내할게요. 먼저 ${c.label} 관리자 화면에서 앱을 만들고, 나오는 키를 여기 붙여 넣으시면 됩니다.`, slips: [{ name: `${c.label} 연결 안내 시작`, st: 'run', state: '기다리는 중' }] }); S.livView = 'chat'; save(); go('#/liv'); toast(`${c.label}은 리브가 안내해요 — 리브 탭으로 옮깁니다.`); return; }
      S.conn[id] = 'busy'; save(); renderLibrary(page); toast(`새 탭에서 ${c.label} 허용을 기다리는 중…`);
      setTimeout(() => { S.conn[id] = 'on'; S.knowledge += id === 'notion' ? 18 : 12; S.library.unshift({ t: id === 'notion' ? '노션 회의록 18건' : '드라이브 새 파일 12건', src: id, when: '방금' }); save(); if (location.hash.startsWith('#/library')) renderLibrary(page); toast(`${c.label}을 연결했어요 — ${id === 'notion' ? '회의록 18건' : '파일 12건'}이 들어왔고 앞으로 새 자료도 따라와요.`); }, 1400);
    }));
    $$('[data-liv-view]', page).forEach((b) => b.addEventListener('click', () => { S.livView = b.dataset.livView; save(); }));
    const qi = $('#libQ'); qi.addEventListener('input', () => { S.libQ = qi.value; save(); const pos = qi.selectionStart; renderLibrary(page); const n = $('#libQ'); n.focus(); n.setSelectionRange(pos, pos); });
    $$('[data-dup]', page).forEach((b) => b.addEventListener('click', () => { S.library = S.library.filter((d) => !d.dup); S.decisions.push(b.dataset.dup === 'new' ? '최신 기준: 가격 정책 8월' : '가격 정책 두 문서 모두 유지'); save(); renderLibrary(page); toast('정했어요. 다음부터 그 기준으로 답합니다.'); }));
  }

  /* ═════════════════════════ 진행 중인 일 ═════════════════════════ */
  function renderWork(page) {
    const f = S.workFilter || 'run';
    const rows = S.work.filter((w) => f === 'run' ? ['busy', 'wait'].includes(w.st) : f === 'wait' ? w.st === 'wait' : f === 'done' ? w.st === 'done' : true);
    const cnt = (s) => S.work.filter((w) => s.includes(w.st)).length;
    const sched = S.work.filter((w) => w.st === 'sched');
    page.innerHTML = `<div class="page-head"><h1>진행 중인 일</h1><span class="sub">맡겨 둔 일이 어디까지 갔는지 — 확인이 필요한 것부터 위에 옵니다.</span><div class="acts"><a class="btn btn-primary btn-sm" href="#/home">${ic('plus', 'ic-sm')} 새로 시키기</a></div></div>
    <div class="work-page">
      <div class="filters"><button class="btn btn-ghost btn-sm ${f === 'run' ? 'on' : ''}" data-wf="run">진행 중 <span class="num">${cnt(['busy', 'wait'])}</span></button><button class="btn btn-ghost btn-sm ${f === 'wait' ? 'on' : ''}" data-wf="wait">확인 필요 <span class="num">${cnt(['wait'])}</span></button><button class="btn btn-ghost btn-sm ${f === 'done' ? 'on' : ''}" data-wf="done">끝남 <span class="num">${cnt(['done'])}</span></button><span class="sp"></span>${S.terminal === 'yes' ? `<button class="btn btn-ghost btn-sm">${ic('term', 'ic-sm')} 터미널로 열기</button>` : `<span class="muted" style="font-size:12.5px">터미널로 열기(고급)</span>`}</div>
      <section class="zone"><div class="zone-b">${rows.length ? rows.slice().sort((a, b) => (a.st === 'wait' ? -1 : 0) - (b.st === 'wait' ? -1 : 0)).map(workRowHTML).join('') : `<div class="note-dash" style="margin:6px">여기엔 아직 없어요.</div>`}</div></section>
      <section class="zone"><div class="zone-h"><h4>매주 하기</h4><span class="n">${sched.length}</span><span class="muted" style="font-size:12.5px">자동</span></div><div class="zone-b">${sched.length ? sched.map(workRowHTML).join('') : `<div class="note-dash" style="margin:6px">아직 없어요 — 리브: "월요일 아침마다 지난주 회의 결정을 모아 둘까요?" <button class="btn btn-mint btn-xs" data-liv-ok="weekly" style="margin-left:6px">켜기</button></div>`}</div></section>
      <p class="footline">동시에 3개까지 맡길 수 있어요 · 지금 ${cnt(['busy'])}개.<br>쓰지 않으면 절전되고, 다시 열면 그 자리에서 복원됩니다. 진행 중이던 도구 작업은 남지 않습니다(대화는 남습니다).</p>
    </div>`;
    $$('[data-wf]', page).forEach((b) => b.addEventListener('click', () => { S.workFilter = b.dataset.wf; save(); renderWork(page); }));
    bindWorkRows(page); bindLivCards(page);
  }

  /* ═════════════════════════ 리브 ═════════════════════════ */
  /* ═════════════════════════ 리브 탭 ═════════════════════════
     리브 = 워크스페이스 운영 담당자. 이 탭은 셋으로 나뉜다:
     ① 대화 — 부탁하는 곳. 빈 상태에선 "지금 내 상태에서 리브가 할 수 있는 일"을 대화로 알아간다.
     ② 리브가 만든 지식 — 자료에서 리브가 증류해 둔 것(위키). 답의 근거이자 고칠 수 있는 대상.
     ③ 오른쪽 레일 — 손볼 것·상태·설정. */

  /* ── 부탁할 수 있는 것의 지도: 역할·자료·연결 상태로 문장을 만든다 ── */
  const KIND = { tidy: '정리', auto: '자동', watch: '먼저 알려주기', conn: '연결·가져오기', ask: '확인', undo: '되돌리기·고치기', share: '초대·공유', ai: '내 AI에게' };
  const KIND_LEAD = { tidy: '자료함을 어떻게 나누고 접어 둘지', auto: '반복되는 일은 리브가 돌립니다', watch: '리브가 먼저 말을 거는 조건', conn: '살아 있는 서비스는 연결해 두면 계속 따라옵니다', ask: '지금 어떻게 돼 있는지 묻기', undo: '리브가 정한 건 전부 되돌릴 수 있어요', share: '동료가 들어오면 팀의 기억이 됩니다', ai: '자료 내용을 묻는 건 리브가 아니라 내 AI — 홈으로 넘겨 드려요' };
  const MAP_ROLE = fromP('map');
  function livMap() {
    const r = roleOf(); const R = P().map; const T = pick(TALLY_BY_ROLE, r);
    const files = S.ingest.total > 0; const onFiles = files ? `자료 ${S.knowledge}건` : '자료 넣은 뒤';
    const notion = S.conn.notion === 'on', gd = S.conn.gdrive === 'on';
    const it = (kind, say, then, on) => ({ kind, say, then, on });
    const g = {};
    g.auto = R.auto.map(([a, b]) => it('auto', a, b, onFiles));
    g.watch = R.watch.map(([a, b]) => it('watch', a, b, onFiles));
    g.tidy = R.tidy.map(([a, b]) => it('tidy', a, b, files ? `${T[0][0]} ${T[0][1]}건` : '자료 넣은 뒤'));
    g.conn = [
      notion ? it('conn', "노션 '회의' 페이지 말고 다른 페이지도 가져와 줘", '가져올 페이지를 골라 두면 그 페이지의 새 글도 따라와요', '노션 연결됨') : it('conn', '노션 연결해 줘', '노션 쪽에서 허용 한 번 — 회의록이 자료함으로 계속 들어와요', '읽기 권한만'),
      gd ? it('conn', "드라이브는 '계약서' 폴더만 보게 해 줘", '보는 범위를 줄이면 무관한 파일이 안 섞여요', '드라이브 연결됨') : it('conn', '구글 드라이브 연결해 줘', '구글 허용 한 번 — 폴더의 새 파일이 계속 따라와요', '읽기 권한만'),
      it('conn', '슬랙 #general 채널도 연결해 줘', '슬랙은 앱 발급이 한 번 필요해서 리브가 한 걸음씩 안내해요', '준비 중'),
    ];
    g.ask = [
      it('ask', '지금 자료함이 어떻게 나뉘어 있어?', `${T.map((t) => `${t[0]} ${t[1]}`).join(' · ')}처럼 갈래와 건수를 말해 줘요`, onFiles),
      it('ask', '어제 뭐 정리했어?', '리브가 손댄 것과 그 이유를 시간순으로', '일지'),
      it('ask', '이번 달 Claude 사용량 얼마나 돼?', `내 구독으로 ${S.usage}회 — 리브가 쓴 몫도 포함해서`, S.aiConnected ? 'Claude 연결됨' : '연결 후'),
    ];
    g.undo = [
      it('undo', '방금 정한 것 되돌려 줘', (S.decisions.slice(-1)[0] ? `최근: ${S.decisions.slice(-1)[0]}` : '리브가 정한 게 생기면') + ' — 그것만 되돌려요', `정한 것 ${S.decisions.length}`),
      it('undo', '회의록은 전부 남기는 걸로 바꿔 줘', '결정·할 일만 남기던 규칙을 전문 유지로', '정리 규칙'),
      it('undo', 'AI 눈높이를 기술 설명 자세히로 바꿔 줘', '답할 때 용어와 깊이가 달라져요', `지금 ${roleOf() === '개발' ? '자세히' : '쉬운 말'}`),
    ];
    g.share = [
      S.team ? it('share', '김민수님한테 회의록 갈래만 공유해 줘', '어니스트AI에 회의록만 올려 두고 나머지는 내 것으로', '팀 워크스페이스') : it('share', '동료 초대 링크 줘', `초대장 ${S.invitesLeft}장 — 동료가 들어오면 팀 워크스페이스가 생겨요`, '초대'),
      it('share', '이 답을 링크로 공유해 줘', '읽기 전용 링크 — 상대는 로그인 없이 봐요', '공유'),
    ];
    g.ai = pick(FIRSTQ_BY_ROLE, r).slice(0, 2).map((q) => it('ai', q, '홈에서 내 AI가 자료를 읽고 답해요', '홈으로'));
    return g;
  }
  const PAINS = [
    ['auto', '자료 올 때마다 하는 반복 작업이 귀찮아요'],
    ['watch', '놓치거나 빠뜨리는 게 있어요'],
    ['tidy', '자료함이 어수선해요'],
    ['ask', '지금 상태가 궁금해요'],
    ['all', '전부 보여 주세요'],
  ];
  const sugBtn = (i) => `<button type="button" class="sug" data-open-say="${esc(i.say)}" ${i.kind === 'ai' ? 'data-to-home="1"' : ''}><span class="kind k-${i.kind}">${KIND[i.kind]}</span><span class="say">${esc(i.say)}</span><span class="then">→ ${esc(i.then)}</span><span class="on">${esc(i.on)}</span></button>`;
  const mapGridHTML = () => { const g = livMap(); return `<div class="map-grid">${['auto', 'watch', 'tidy', 'conn', 'ask', 'undo', 'share', 'ai'].map((k) => `<section class="mg mg-${k}"><header class="mg-h"><span class="kind k-${k}">${KIND[k]}</span><span class="mg-t">${KIND_LEAD[k]}</span></header>${g[k].map(sugBtn).join('')}</section>`).join('')}</div>`; };
  function livOpeningHTML() {
    const r = roleOf(); const T = pick(TALLY_BY_ROLE, r); const files = S.ingest.total > 0;
    const conns = Object.entries(S.conn).filter(([, v]) => v === 'on').map(([k]) => SOURCES.find((s) => s.id === k).label);
    const state = [files ? `자료 <b>${S.knowledge}건</b>(${T.map((t) => `${t[0]} ${t[1]}`).join(' · ')})` : '자료는 아직 비어 있고', conns.length ? `${conns.join('·')} 연결` : '연결한 서비스는 아직 없고', S.aiConnected ? 'Claude로 답합니다' : 'AI는 연결 전이에요'].join(', ');
    return `<div class="liv-open">
      <div class="work"><div class="who liv">${livFace(16)}<span>리브</span></div>
        <div class="said">${esc(r)} 일 하시죠. 지금 ${state}. 이 상태에서 <b>제가 대신 할 수 있는 일</b>을 골라 드릴게요 — 요즘 뭐가 제일 손이 가세요?</div>
        <div class="pains">${PAINS.map(([k, t]) => `<button type="button" class="chip" data-pain="${k}" data-open-say="${esc(t)}">${esc(t)}</button>`).join('')}</div>
        <div class="said muted" style="margin-top:12px;font-size:13px">아래는 전체 지도예요. 사용법을 알려 드리는 게 아니라 제가 대신 손봅니다 — <b>눌러서 그대로 보내도 돼요.</b> 문장은 ${esc(r)} 자료 기준으로 만들었어요.</div>
      </div>
      ${mapGridHTML()}
    </div>`;
  }
  /* ── 리브가 만든 지식(위키) ── */
  const WIKI_BY_ROLE = fromP('wiki');
  const wikiOf = () => (S.ingest.total ? pick(WIKI_BY_ROLE, roleOf()) : []);
  function livWikiHTML() {
    const w = wikiOf(); const sel = Math.min(S.livWikiSel || 0, Math.max(0, w.length - 1)); const cur = w[sel];
    if (!w.length) return `<div class="wiki-empty"><b>아직 만든 지식이 없어요.</b><p>자료를 넣으면 리브가 읽고 요약·규칙·대조 결과를 여기 남깁니다. 답의 근거가 되고, 틀리면 여기서 고칩니다.</p><a class="btn btn-primary btn-sm" href="#/welcome">자료 넣기</a></div>`;
    return `<div class="wiki">
      <aside class="wiki-list">
        <div class="wiki-h"><b>리브가 만든 지식 · ${w.length + S.decisions.length}</b><span class="k">자료 ${S.knowledge}건에서</span></div>
        <input class="in wiki-q" type="search" placeholder="찾기" aria-label="지식 찾기">
        <div class="wiki-sec">자료에서 만든 것 · ${w.length}</div>
        ${w.map((e, i) => `<button type="button" class="wk ${i === sel ? 'cur' : ''}" data-wk="${i}"><span class="kind">${esc(e.kind)}</span><b>${esc(e.t)}</b><small>${e.src.length}건에서 · ${esc(e.when)}</small></button>`).join('')}
        <div class="wiki-sec">리브가 정한 것 · ${S.decisions.length}</div>
        ${S.decisions.length ? S.decisions.map((d, i) => `<div class="wk dec"><span class="kind">규칙</span><b>${esc(d)}</b><button type="button" class="undo" data-undo-dec="${i}" title="이것만 되돌리기">✕</button></div>`).join('') : `<div class="wk dec muted"><small>아직 없어요.</small></div>`}
      </aside>
      <article class="wiki-body">
        <div class="wiki-kind"><span class="kind">${esc(cur.kind)}</span><span class="muted">${esc(cur.when)} · 리브가 만듦</span></div>
        <h2>${esc(cur.t)}</h2>
        <pre class="wiki-text">${esc(cur.body)}</pre>
        <div class="wiki-src"><span class="k">근거</span>${cur.src.map((x) => `<a class="ev" href="#/library"><span class="k">자료</span>${esc(x)}</a>`).join('')}</div>
        <div class="wiki-acts"><button type="button" class="btn btn-ghost btn-sm" data-wk-fix>틀렸어요 — 고쳐 주기</button><button type="button" class="btn btn-ghost btn-sm" data-wk-redo>자료 다시 읽고 만들기</button><a class="btn btn-ghost btn-sm" href="#/library">원문 보기</a></div>
        <p class="wiki-fine">이 내용은 내 AI가 답할 때 근거로 씁니다. 고치면 다음 답부터 반영돼요.</p>
      </article>
    </div>`;
  }
  function renderLiv(page) {
    const cards = livCards();
    const conns = Object.entries(S.conn).filter(([, v]) => v === 'on').map(([k]) => SOURCES.find((s) => s.id === k).label);
    const view = S.livView || 'chat'; const log = S.livLog || [];
    const wikiN = wikiOf().length + S.decisions.length;
    const ph = { '법무·계약': '"새 계약서 올라오면 표준과 대조해 둬", "노션 끊어 줘"', '연구·대학원': '"새 논문 넣으면 요약 만들어 둬", "노션 끊어 줘"', '개발': '"릴리스 노트 올라오면 요약 만들어 둬", "노션 끊어 줘"' }[roleOf()] || '"매주 월요일에 회의 결정 모아 줘", "노션 끊어 줘"';
    page.innerHTML = `<div class="livpage">
      <aside class="rail">
        <div class="rc"><span class="k">지금 손볼 것 · ${cards.length}</span>${cards.length ? cards.map((c, i) => `<div class="liv-card ${c.p0 ? 'p0' : ''}" style="margin-top:6px"><div class="t"><span class="mark">${c.p0 ? '!' : '·'}</span><b>${esc(c.t)}</b></div><div class="d">${esc(c.d)}</div><div class="a"><button class="btn ${i === 0 ? 'btn-mint' : 'btn-ghost'} btn-xs" data-liv-ok="${c.id}">${esc(c.ok)}</button><button class="btn btn-ghost btn-xs" data-liv-later="${c.id}">${esc(c.later || '나중에')}</button></div></div>`).join('') : `<div class="d muted" style="font-size:12.5px;margin-top:4px">지금은 없어요. 자료가 새로 생기면 알아서 정리하고, 이상하면 먼저 말을 걸게요.</div>`}</div>
        <div class="rc"><span class="k">내 워크스페이스 상태</span><div class="status-list"><span class="state ${conns.length ? 'on' : 'off'}">자료 들어옴${conns.length ? `(${conns.join('·')} · 12분 전)` : ' — 연결 전'}</span><span class="state on">정리 돌아감(마지막 1시간 전)</span><span class="state on">낡은 것 점검(매일 아침)</span><span class="state ${S.conn.notion === 'on' ? 'on' : 'off'}">노션 — ${S.conn.notion === 'on' ? '연결됨' : '연결 전'}</span></div></div>
        <div class="rc"><span class="k">나 · AI 눈높이</span><div class="v" style="font-size:13.5px">${esc(roleOf())} · ${roleOf() === '개발' ? '기술 설명 자세히' : '비개발'} · 존댓말 · 한국어 <button class="btn-text" style="padding:0 4px" data-open-say="AI 눈높이를 ${roleOf() === '개발' ? '쉬운 말' : '기술 설명 자세히'}로 바꿔 줘">고치기</button></div></div>
        <div class="rc"><span class="k">쓰는 AI</span><div class="v" style="font-size:13.5px">${S.aiConnected ? '<span class="state on">Claude 연결됨</span>' : S.ai ? `<span class="state wait">${esc(S.ai)} — 연결 전</span>` : '<span class="state off">아직 없음</span>'} · <span class="muted">다시 로그인 · 터미널에서도 쓰기</span></div></div>
        <div class="rc"><span class="k">고급</span><div class="adv"><a>연결 관리</a><a>정리 규칙</a><a>자동 실행 주기</a><a>내보내기·삭제</a><a>계정</a></div></div>
      </aside>
      <section class="journal">
        <nav class="liv-sub" aria-label="리브 보기"><button type="button" class="${view === 'chat' ? 'active' : ''}" data-view="chat">대화</button><button type="button" class="${view === 'wiki' ? 'active' : ''}" data-view="wiki">리브가 만든 지식 <span class="n">${wikiN}</span></button><span class="liv-sub-hint">${view === 'wiki' ? '자료에서 리브가 증류한 것 — 답의 근거이고, 여기서 고칠 수 있어요.' : '부탁은 여기서. 눌러서 그대로 보내도 돼요.'}</span></nav>
        ${view === 'wiki' ? `<div class="jl-scroll wiki-scroll" id="livJl">${livWikiHTML()}</div>` : `<div class="jl-scroll" id="livJl">${livJournalHTML()}</div>
        ${log.length ? `<div class="map-strip"><button type="button" class="btn-text" data-map-toggle aria-expanded="${S.livMapOpen ? 'true' : 'false'}">부탁할 수 있는 것 ${S.livMapOpen ? '접기 ▴' : '전부 보기 ▾'}</button><span class="muted">${esc(roleOf())} 자료 기준으로 만든 문장이에요.</span></div><div class="map-drawer" ${S.livMapOpen ? '' : 'hidden'}>${mapGridHTML()}</div>` : ''}
        <form class="compose" id="livCompose"><textarea id="livIn" rows="1" placeholder='리브에게 말하기 — ${ph}'></textarea><button class="btn btn-primary" type="submit">보내기</button></form>`}
      </section>
    </div>`;
    bindLivCards(page);
    $$('[data-view]', page).forEach((b) => b.addEventListener('click', () => { S.livView = b.dataset.view; save(); render(); }));
    if (view === 'wiki') { bindWiki(page); return; }
    const form = $('#livCompose'), inp = $('#livIn'), list = $('#livJl');
    const send = async (v) => {
      S.livLog = S.livLog || []; S.livLog.push({ me: v }); save();
      const wasEmpty = !$('.turn', list);
      if (wasEmpty) { render(); return sendReplyOnly(v); }
      list.innerHTML = livJournalHTML(); list.scrollTop = list.scrollHeight;
      await wait(650); const rep = livReply(v); S.livLog.push(rep); save();
      if (rep.rerender) return render();
      list.innerHTML = livJournalHTML(); bindLivInline(list); list.scrollTop = list.scrollHeight;
    };
    const submit = (e) => { e.preventDefault(); const v = inp.value.trim(); if (!v) return; inp.value = ''; send(v); };
    form.addEventListener('submit', submit); inp.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) submit(e); });
    const bindSays = () => $$('[data-open-say]', page).forEach((b) => { if (b.dataset.bound) return; b.dataset.bound = 1; b.addEventListener('click', () => {
      if (b.dataset.toHome) { S.homePrefill = b.dataset.openSay; save(); go('#/home'); toast('그건 내 AI가 답할 일이라 홈으로 넘겼어요 — 보내기만 누르세요.'); return; }
      send(b.dataset.openSay);
    }); });
    bindSays(); bindLivInline(list);
    const mt = $('[data-map-toggle]', page); if (mt) mt.addEventListener('click', () => { S.livMapOpen = !S.livMapOpen; save(); render(); });
    if (log.length) list.scrollTop = list.scrollHeight; else list.scrollTop = 0;
  }
  async function sendReplyOnly(v) { await wait(650); const rep = livReply(v); S.livLog.push(rep); save(); render(); const l = $('#livJl'); if (l) l.scrollTop = l.scrollHeight; }
  function bindWiki(page) {
    $$('[data-wk]', page).forEach((b) => b.addEventListener('click', () => { S.livWikiSel = +b.dataset.wk; save(); render(); }));
    $$('[data-undo-dec]', page).forEach((b) => b.addEventListener('click', () => { const gone = S.decisions.splice(+b.dataset.undoDec, 1); save(); render(); toast(`되돌렸어요 — ${gone[0] || ''}`); }));
    const fix = $('[data-wk-fix]', page); if (fix) fix.addEventListener('click', () => { const cur = wikiOf()[S.livWikiSel || 0]; S.livView = 'chat'; S.livLog = S.livLog || []; S.livLog.push({ me: `"${cur.t}" 내용이 틀렸어. 고쳐 줘.` }); S.livLog.push({ liv: `어디가 다른지 한 줄만 알려 주시면 그 부분만 고치고, 근거 자료도 다시 확인할게요. <span class="muted">(예: "위약금은 15%야")</span>`, slips: [{ name: `지식 "${cur.t}" 수정 대기`, st: 'run', state: '기다리는 중' }] }); save(); render(); });
    const redo = $('[data-wk-redo]', page); if (redo) redo.addEventListener('click', (e) => { e.currentTarget.classList.add('is-busy'); setTimeout(() => { toast('자료를 다시 읽고 만들었어요 — 내용은 같습니다.'); e.target.classList.remove('is-busy'); }, 1100); });
    const q = $('.wiki-q', page); if (q) q.addEventListener('input', () => { const t = q.value.trim(); $$('.wk[data-wk]', page).forEach((el) => { el.hidden = t && !el.textContent.includes(t); }); });
  }
  /* 리브의 답 — 지도의 문장은 전부 구체적으로 응답한다(프로토타입 시뮬레이션) */
  const ladder = (arr) => arr.length ? `<div class="ladder"><span class="k">이것도 됩니다 →</span>${arr.map((x) => `<button type="button" class="chip" data-open-say="${esc(x)}">${esc(x)}</button>`).join('')}</div>` : '';
  const sugList = (items, lead) => `<div class="said" style="margin-top:8px">${lead}</div><div class="sug-list">${items.map(sugBtn).join('')}</div>`;
  function livReply(v) {
    const g = livMap(); const all = Object.values(g).flat(); const T = pick(TALLY_BY_ROLE, roleOf()); const r = roleOf();
    const pain = PAINS.find(([, t]) => t === v);
    if (pain) {
      const [k] = pain;
      if (k === 'all') { S.livMapOpen = true; return { liv: '아래 <b>부탁할 수 있는 것</b>을 전부 펼쳤어요. 어느 것이든 눌러서 그대로 보내면 됩니다.', rerender: true }; }
      const lead = { auto: '반복 작업은 한 번 말해 두면 제가 계속 돌립니다. 지금 자료 기준으로 셋을 골랐어요 —', watch: '제가 먼저 말을 걸 조건을 정해 두는 거예요. 지금 자료에서 걸릴 만한 것 셋 —', tidy: '자료함 갈래와 접어 두는 규칙을 바꿀 수 있어요. 지금 상태에서 손댈 만한 것 —', ask: '언제든 물어보시면 됩니다. 지금 답할 수 있는 것 —' }[k];
      const items = g[k].concat(k === 'auto' ? g.watch.slice(0, 1) : k === 'watch' ? g.auto.slice(0, 1) : k === 'tidy' ? g.undo.slice(1, 2) : g.undo.slice(0, 1));
      return { liv: `${lead}`, after: sugList(items, '눌러서 그대로 보내도 돼요.') };
    }
    const hit = all.find((i) => i.say === v);
    const addWork = (id, t, m) => { if (!S.work.find((w) => w.id === id)) S.work.push({ id, t, st: 'sched', when: '자동', m }); };
    if (hit) {
      switch (hit.kind) {
        case 'auto': {
          const id = 'auto-' + all.indexOf(hit); addWork(id, hit.say.replace(/ 줘$| 둬$/, ''), '자동 · 리브');
          if (!S.decisions.includes(hit.say)) S.decisions.push('자동: ' + hit.say.replace(/ 줘$| 둬$/, ''));
          const now = S.ingest.total ? `지금 있는 ${T[0][0]} ${T[0][1]}건도 한 번 돌릴까요?` : '자료가 들어오면 바로 시작해요.';
          return { liv: `켰어요. ${esc(hit.then)}. ${now}`, slips: [{ name: `자동 실행 등록 · ${hit.say.replace(/ 줘$| 둬$/, '')}`, st: 'done', raw: 'owner=me · cost=내 구독 · 결과 → 진행 중인 일' }], after: ladder(S.ingest.total ? ['지금 있는 것도 돌려 줘', '결과는 매번 알려 주지 말고 모아서 줘'] : ['결과는 모아서 한 번에 줘']) };
        }
        case 'watch': {
          S.decisions.push('먼저 알려주기: ' + hit.say.replace(/ 줘$/, ''));
          return { liv: `그렇게 할게요. ${esc(hit.then)}. 걸리면 홈의 <b>지금 손볼 것</b>에 카드로 올리고, 급하지 않은 건 모아서 아침에 말씀드려요.`, slips: [{ name: `점검 조건 추가 · ${hit.say.replace(/ 줘$/, '')}`, st: 'done', raw: 'watch rule · quiet=true(모아서) · channel=홈 카드' }], after: ladder(['걸리면 바로바로 알려 줘', '지금 자료에서 걸리는 것 있는지 봐 줘']) };
        }
        case 'tidy': {
          S.decisions.push('정리: ' + hit.say.replace(/ 줘$/, ''));
          return { liv: `정리했어요. ${esc(hit.then)}. 자료함에서 바로 보이고, 새 자료도 이 규칙으로 들어갑니다. 마음에 안 들면 "되돌려 줘" 한마디면 돼요.`, slips: [{ name: `정리 규칙 적용 · ${hit.say.replace(/ 줘$/, '')}`, st: 'done', raw: `${S.knowledge}건 재분류 · 이동만, 삭제 없음` }], after: ladder(['자료함 보여 줘', '방금 정한 것 되돌려 줘']) };
        }
        case 'conn': {
          if (/노션 연결/.test(v)) return { liv: '노션 쪽에서 출입증(연결 허용)을 한 번 눌러 주셔야 해요. 제가 한 걸음씩 안내할게요. 먼저 <button class="btn btn-primary btn-xs" data-inline="notion">노션 열기</button>' };
          if (/드라이브 연결/.test(v)) return { liv: '구글에서 허용 한 번이면 돼요. <button class="btn btn-primary btn-xs" data-inline="gdrive">구글로 연결</button> — 읽기 권한만 받고, 폴더는 다음에 고를 수 있어요.' };
          if (/슬랙/.test(v)) return { liv: '슬랙은 앱 발급이 한 번 필요해서 지금 바로는 못 하고, 준비되면 <b>홈에서 한 걸음씩</b> 안내할게요. 요청으로 남겨 둘까요? <button class="btn btn-ghost btn-xs" data-inline="req">요청 남기기</button>' };
          if (/폴더만/.test(v)) return { liv: "드라이브에서 보는 범위를 '계약서' 폴더로 줄였어요. 그 밖의 새 파일은 안 들어옵니다.", slips: [{ name: '드라이브 범위 변경 · 폴더 1개', st: 'done' }] };
          return { liv: '노션에서 가져올 페이지를 골라 주세요 — 지금은 <b>회의</b> 페이지만 보고 있어요.', after: `<div class="sug-list">${['계약 검토', '팀 위키', '고객 미팅'].map((x) => `<button type="button" class="chip" data-open-say="노션 '${x}' 페이지도 가져와 줘">${x}</button>`).join('')}</div>` };
        }
        case 'ask': {
          if (/자료함/.test(v)) return { liv: `지금 자료함은 ${T.map((t) => `<b>${t[0]}</b> ${t[1]}`).join(' · ')}로 나뉘어 있어요(총 ${S.knowledge}건). ${S.conn.notion === 'on' ? '노션에서 12분 전에 마지막으로 들어왔고, ' : ''}정리는 1시간 전에 마지막으로 돌았어요.`, after: ladder(['갈래를 바꾸고 싶어', '자료함 보여 줘']) };
          if (/어제/.test(v)) return { liv: '어제 제가 한 일이에요.', slips: [{ name: `${T[0][0]} 3건 새로 들어옴 → 갈래 배정`, st: 'done', state: '어제 09:10' }, { name: '겹치는 문서 1쌍 발견 → 최신 기준 적용', st: 'done', state: '어제 09:12' }, { name: '3개월 안 본 자료 점검 — 해당 없음', st: 'done', state: '어제 08:00' }], after: ladder(['오늘은 뭐 할 예정이야?']) };
          return { liv: `이번 달 Claude 사용은 <b>${S.usage}회</b>예요. 저(리브)가 쓴 몫도 포함이고, 상세는 프로필의 사용량에서 언제든 볼 수 있어요.` };
        }
        case 'undo': {
          if (/방금 정한/.test(v)) { const gone = S.decisions.pop(); return gone ? { liv: `되돌렸어요 — <b>${esc(gone)}</b>. 그것만 되돌렸고 나머지는 그대로예요.`, slips: [{ name: '되돌리기 1건', st: 'done' }] } : { liv: '아직 제가 정한 게 없어요. 정하면 여기서 하나씩 되돌릴 수 있어요.' }; }
          if (/회의록/.test(v)) { S.decisions = S.decisions.filter((d) => !d.startsWith('회의록')); S.decisions.push('회의록 전문 유지'); return { liv: '바꿨어요. 회의록은 이제 전문을 남깁니다 — 결정·할 일은 위에 따로 뽑아 두고요.', slips: [{ name: '정리 규칙 변경 · 회의록 전문 유지', st: 'done' }] }; }
          if (/눈높이/.test(v)) { return { liv: `AI 눈높이를 <b>${/자세히/.test(v) ? '기술 설명 자세히' : '쉬운 말'}</b>로 바꿨어요. 다음 답부터 반영돼요.`, slips: [{ name: 'AI 눈높이 변경', st: 'done' }] }; }
          break;
        }
        case 'share': {
          if (/초대 링크/.test(v)) { inviteLink(); return { liv: `초대 링크를 복사했어요(초대장 ${S.invitesLeft}장). 동료가 들어오면 <b>팀 워크스페이스</b>가 생기고, 왼쪽 위에서 오갈 수 있어요. 초대받은 사람은 AI 구독이 없어도 보고 쓸 수 있습니다.` }; }
          if (/공유해 줘/.test(v) && /갈래/.test(v)) return { liv: '회의록 갈래만 어니스트AI에 올려 두었어요. 나머지는 내 워크스페이스에 그대로예요.', slips: [{ name: '팀 공유 · 회의록 갈래', st: 'done' }] };
          return { liv: '읽기 전용 링크를 만들었어요 — 상대는 로그인 없이 봅니다. <span class="mono">app.lvly.io/s/8f2k</span>', slips: [{ name: '공유 링크 생성 · 읽기 전용', st: 'done' }] };
        }
      }
    }
    /* 자유 입력 — 대충 말해도 알아듣는 폴백 */
    if (/노션.*(끊|해제)/.test(v)) { S.conn.notion = 'off'; S.declined.push('notion'); return { liv: '노션 연결을 끊었어요. 들어와 있던 회의록 18건은 자료함에 남겨 두었고, 새 자료는 더 안 들어옵니다.', slips: [{ name: '노션 연결 해제', st: 'done' }] }; }
    if (/노션/.test(v)) return { liv: '노션을 연결하려면 노션 쪽에서 출입증(연결 허용)을 한 번 눌러 주셔야 해요. 먼저 <button class="btn btn-primary btn-xs" data-inline="notion">노션 열기</button>' };
    if (/지금 있는 것도/.test(v)) { addWork('backfill', `${T[0][0]} ${T[0][1]}건 한 번 돌리기`, '진행 중 · 리브'); return { liv: `${T[0][0]} ${T[0][1]}건에 지금 돌리기 시작했어요. 끝나면 진행 중인 일에 결과가 올라와요 — 몇 분 걸립니다.`, slips: [{ name: `일괄 처리 · ${T[0][1]}건`, st: 'run' }] }; }
    if (/모아서/.test(v)) return { liv: '알겠어요. 매번 알리지 않고 <b>아침에 한 번</b> 모아서 말씀드릴게요.', slips: [{ name: '알림 방식 · 모아서(매일 08:00)', st: 'done' }] };
    if (/바로바로/.test(v)) return { liv: '알겠어요. 걸리는 즉시 홈 카드로 올릴게요.', slips: [{ name: '알림 방식 · 즉시', st: 'done' }] };
    if (/걸리는 것 있는지/.test(v)) return { liv: `지금 자료에서 하나 걸려요 — <b>${r === '법무·계약' ? '검토 요청 계약서(18쪽): 7조 위약금 20%(표준 10%)' : r === '연구·대학원' ? 'Lee (2024)가 2장 초안과 반대 결과' : r === '개발' ? 'API v2 스펙 미결 2건' : '가격 정책 v3·7월 두 벌'}</b>. 홈의 지금 손볼 것에도 올려 두었어요.`, slips: [{ name: '점검 1회 실행 · 걸림 1건', st: 'done' }] };
    if (/자료함 보여/.test(v)) return { liv: '자료함으로 안내할게요. <a class="btn btn-ghost btn-xs" href="#/library">자료함 열기</a>' };
    if (/오늘은 뭐/.test(v)) return { liv: '오늘은 아침 8시 점검을 끝냈고, 새 자료가 들어오면 갈래에 넣고, 월요일이면 지난주 결정을 모아 둘 예정이에요. 시키실 게 있으면 지금 말씀해 주세요.' };
    if (/매주|월요일|자동/.test(v)) { addWork('weekly', '매주 월요일 · 지난주 회의 결정 모으기', '자동 · 월요일 08:00'); return { liv: '켰어요. 월요일 아침 8시에 지난주 회의 결정을 모아 <b>진행 중인 일</b>에 두겠습니다. 첫 결과는 다음 월요일에 옵니다.', slips: [{ name: '자동 실행 등록 · 매주 월요일 08:00', st: 'done', raw: 'cron: weekly-meeting-digest · owner=me · cost=내 구독' }] }; }
    if (/속성|데이터베이스|DB/.test(v)) return { liv: '그건 아직 못 해요. 요청으로 남겨 둘게요 — 되면 먼저 알려 드립니다. <button class="btn btn-ghost btn-xs" data-inline="req">요청 남기기</button>' };
    if (/얼마|사용량|토큰/.test(v)) return { liv: `이번 달 Claude 사용은 <b>${S.usage}회</b>예요. 저(리브)가 쓴 몫도 포함이고, 상세는 프로필의 사용량에서 언제든 볼 수 있어요.` };
    if (/되돌|취소/.test(v)) return { liv: '무엇을 되돌릴까요? 최근에 제가 정한 것: ' + (S.decisions.slice(-3).map((d) => `<b>${esc(d)}</b>`).join(' · ') || '없음') + ' — 항목을 말씀해 주시면 그것만 되돌립니다.' };
    if (/틀렸|고쳐/.test(v)) return { liv: '어디가 다른지 한 줄만 알려 주시면 그 부분만 고치고 근거 자료도 다시 확인할게요.', slips: [{ name: '지식 수정 대기', st: 'run', state: '기다리는 중' }] };
    if (/[?？]$|뭐였|뭐야|알려 줘$/.test(v) && /계약|회의|보고서|논문|스펙|회고|정책/.test(v)) return { liv: `그건 제가 아니라 <b>${esc(S.name)}님의 AI</b>가 자료를 읽고 답할 일이에요 — 홈으로 넘겨 드릴게요. <button class="btn btn-primary btn-xs" data-inline="tohome" data-q="${esc(v)}">홈에서 시키기</button>` };
    return { liv: '알겠어요. 확인해 볼게요.', slips: [{ name: '워크스페이스 상태 조회', st: 'done', raw: 'pipeline: ok · collectors: ' + Object.values(S.conn).filter((x) => x === 'on').length + ' · pending: 0' }], after: '<div class="said" style="margin-top:6px">지금은 손볼 것이 없어요. 제가 할 수 있는 일이 궁금하시면 아래 <b>부탁할 수 있는 것</b>을 펼쳐 보세요.</div>' };
  }
  function bindLivInline(list) {
    $$('[data-inline]', list).forEach((b) => { if (b.dataset.bound) return; b.dataset.bound = 1; b.addEventListener('click', () => {
      const k = b.dataset.inline;
      if (k === 'notion' || k === 'gdrive') { b.classList.add('is-busy'); setTimeout(() => { S.conn[k] = 'on'; S.knowledge += k === 'notion' ? 18 : 12; S.livLog.push({ liv: k === 'notion' ? '고마워요. 연결됐고 회의록 18개가 보여요. 정리 규칙은 드라이브와 같게(결정·할 일만) 둘까요?' : '연결됐어요. 새 파일 12개가 들어왔고, 앞으로 이 폴더의 새 파일은 자동으로 따라와요.', slips: [{ name: `${k === 'notion' ? '노션' : '드라이브'} 연결(읽기) · 정리 규칙 적용`, st: 'done' }] }); save(); render(); toast(k === 'notion' ? '노션을 연결했어요.' : '드라이브를 연결했어요.'); }, 1200); return; }
      if (k === 'tohome') { S.homePrefill = b.dataset.q; save(); go('#/home'); toast('홈으로 넘겼어요 — 보내기만 누르세요.'); return; }
      S.livLog.push({ liv: '요청을 남겼어요. 되면 여기서 먼저 알려 드릴게요.', slips: [{ name: '미지원 기능 요청 접수', st: 'done', raw: 'feature-request · from=liv chat' }] }); save(); render();
    }); });
  }
  function livJournalHTML() {
    const log = S.livLog || [];
    if (!log.length) return livOpeningHTML();
    return log.map((t) => `<article class="turn">${t.me != null ? `<div class="me-said"><span>${esc(t.me)}</span></div>` : ''}${t.liv != null ? `<div class="work"><div class="who liv">${livFace(16)}<span>리브</span></div><div class="said">${t.liv}</div>${(t.slips || []).map(slipHTML).join('')}${t.after || ''}</div>` : ''}</article>`).join('');
  }

  /* ═════════════════════════ 프로젝트(팀 모드) ═════════════════════════ */
  function renderBoard(page) {
    page.innerHTML = `<div class="page-head"><h1>프로젝트</h1><span class="sub">둘이 되면서 켜졌어요. 담당·마감은 필요할 때만 씁니다.</span><div class="acts"><button class="btn btn-ghost btn-sm">보드</button><button class="btn btn-ghost btn-sm">목록</button><button class="btn btn-primary btn-sm">${ic('plus', 'ic-sm')} 일 추가</button></div></div>
    <div class="board">
      <div class="bcol"><span class="k">할 일 · 2</span><div class="bcard">환불 안내문 고객 발송<div class="m"><span class="who-ava">윤</span>금요일까지</div></div><div class="bcard">표준 계약서 v5 초안<div class="m"><span class="who-ava">김</span>다음 주</div></div></div>
      <div class="bcol"><span class="k">진행 중 · 2</span><div class="bcard">회의 3건 결정 모으기<div class="m"><span class="who-ava">윤</span><span class="state busy">AI 작업 중</span></div></div><div class="bcard">계약서 조항 대조<div class="m"><span class="who-ava">김</span><span class="state busy">AI 작업 중</span></div></div></div>
      <div class="bcol"><span class="k">끝남 · 3</span><div class="bcard">8/12 회의 할 일 정리<div class="m"><span class="who-ava">윤</span>어제 · 결과 → 자료함</div></div><div class="bcard">위약금 조항 정리<div class="m"><span class="who-ava">김</span>3시간 전</div></div><div class="bcard">처음 설정(리브)<div class="m"><span class="who-ava">윤</span>어제</div></div></div>
    </div>`;
  }

  /* ═════════════════════════ 프로토타입 컨트롤 ═════════════════════════ */
  function renderProto() {
    let el = $('#proto'); if (!el) { el = document.createElement('div'); el.id = 'proto'; el.className = 'proto'; document.body.appendChild(el); }
    el.innerHTML = `<button class="proto-btn" id="protoBtn" aria-expanded="false">PROTOTYPE ${ic('chev', 'ic-sm')}</button><div class="proto-menu" id="protoMenu" hidden>
      <span class="k">화면</span><button data-p="start">진입 화면</button><button data-p="welcome">온보딩 룸 <span class="st">${S.ob.finished ? '끝남' : S.ob.started ? `${S.ob.doneSteps.length}/5` : ''}</span></button><button data-p="home">홈</button><button data-p="library">자료함</button><button data-p="work">진행 중인 일</button><button data-p="liv">리브</button><hr>
      <span class="k">시나리오</span><button data-p="day2">다음 날 아침으로 <span class="st">${S.day >= 2 ? '켜짐' : ''}</span></button><button data-p="team">동료가 초대를 수락 <span class="st">${S.team ? '켜짐' : ''}</span></button><button data-p="fast">온보딩 결과 채워 두기</button><hr>
      <button data-p="reset">처음부터(전부 지우기)</button></div>`;
    const btn = $('#protoBtn'), menu = $('#protoMenu');
    btn.onclick = () => { menu.hidden = !menu.hidden; btn.setAttribute('aria-expanded', String(!menu.hidden)); };
    document.addEventListener('click', (e) => { if (!el.contains(e.target)) menu.hidden = true; }, { once: true });
    $$('[data-p]', menu).forEach((b) => b.onclick = () => { const p = b.dataset.p; menu.hidden = true;
      if (p === 'reset') { sessionStorage.removeItem(KEY); S = fresh(); go('#/start'); render(); return; }
      if (p === 'day2') { if (!S.ob.finished) quickFinish(); seedDay2(); go('#/home'); render(); return; }
      if (p === 'team') { if (!S.ob.finished) quickFinish(); if (S.day < 2) seedDay2(); S.team = !S.team; if (!S.team) { S.boardOn = false; S.ws = 'me'; } S.invitesLeft = S.team ? 2 : 3; save(); go('#/home'); render(); toast(S.team ? '김민수님이 초대를 수락했어요 — 팀 워크스페이스 \'어니스트AI\'가 생겼습니다(왼쪽 위에서 전환).' : '팀 시나리오를 껐어요.'); return; }
      if (p === 'fast') { quickFinish(); go('#/home'); render(); return; }
      go('#/' + p); });
  }
  function quickFinish() {
    if (S.ob.finished) return; S.ob.started = true; S.ob.startedAt = S.ob.startedAt || Date.now() - 220000; S.role = S.role || '마케팅'; S.detail = S.detail || PERSONA[S.role].detail.opts[0][0]; if (S.pain == null) S.pain = 0; S.jobs = S.jobs.length ? S.jobs : PERSONA[S.role].jobs[PERSONA[S.role].detail.opts[0][0]].slice(0, 2); S.sources = S.sources.length ? S.sources : ['gdrive', 'notion']; S.files = S.files.length ? S.files : pick(FILES_BY_ROLE, S.role).concat(Array.from({ length: 33 }, (_, i) => `file-${i}`)); S.conn.gdrive = 'on'; S.ai = 'Claude'; S.aiConnected = true; S.terminal = S.terminal || 'no';
    Object.assign(S.ingest, { total: 41, done: 41, running: false, finished: true, tally: pick(TALLY_BY_ROLE, S.role).slice() }); S.knowledge = 42; S.usage = 1;
    S.decisions = [`분류 3갈래(${pick(TALLY_BY_ROLE, S.role).map((t) => t[0]).join('·')})`, '회의록은 결정·할 일만 남김', '최신 기준: 가격 정책 7월', '드라이브 새 파일 자동 반영'];
    S.ob.finished = true; S.ob.finishedAt = Date.now(); S.ob.doneSteps = [1, 2, 3, 4, 5]; S.ob.step = 5; if (!S.fixes.length) { S.fixes = [PERSONA[S.role].bottle[0].slip]; } S.ob.skipped = false;
    if (!S.work.find((w) => w.id === 'firstq')) S.work.unshift({ id: 'firstq', t: pick(FIRSTQ_BY_ROLE, S.role)[0].replace(/\?$/, ''), st: 'done', when: '방금', m: '결과 → 자료함' });
    if (!S.work.find((w) => w.id === 'ob')) S.work.push({ id: 'ob', t: '처음 설정 (리브)', st: 'done', when: '방금', m: '3분 40초 · 되돌리기 가능' });
    S.ob.scene = 'done';
    save();
  }

  render();
})();
