// context-pipeline.ts — 맥락 파이프라인 개요(#1419 T6). [맥락 관리] 탭의 첫 화면.
//
//  이 화면이 답하는 질문 하나: **"지금 어디가 막혔나."**
//  그래서 4단계를 가로로 나란히 놓는다 — 파이프라인의 요점은 단계 '내부'가 아니라 단계 '사이'이고,
//  그건 같은 시점의 숫자를 나란히 봐야만 보인다. 세로로 쌓으면 비교가 안 된다(스크롤이 비교를 끊는다).
//
//  설계 결정 셋:
//   · **막힘을 먼저 말한다** — 카드 안 첫 줄이 상태 문장이다. 숫자만 보여 주면 "3,412 가 많은 건가?"를
//     사람이 판단해야 하는데, 그 판단이 이 제품에서 가장 자주 실패한 지점이다(#1289: 슬랙 10,900건 중
//     증류 13건이었는데 화면상으론 아무 이상이 없어 보였다).
//   · **'안 돌고 있음'을 최우선 경보로** — 설정만 하고 크론을 안 켜서 아무것도 안 도는 것이 대표 실패 모드다.
//     잔량이 0이어도 잡이 꺼져 있으면 그건 '깨끗한' 게 아니라 '멈춘' 것이다.
//   · **각 카드가 곧 그 단계의 입구** — 클릭하면 그 단계 설정으로 간다(별도 내비 학습 불요).
import { fmtNum } from './core.js';

/** 단계 하나의 판정 결과 — 색·문구·심각도를 한 곳에서 정한다(카드마다 다른 잣대가 생기지 않게). */
type Health = { level: 'ok' | 'note' | 'warn' | 'off'; line: string };

/** 잡이 꺼져 있으면 무엇보다 먼저 말한다 — 잔량 0 이 '깨끗함'이 아니라 '멈춤'일 수 있다.
 *  ⚠ 문구는 **사람 말**로만 쓴다(#1841) — '증류 자동 실행이 등록돼 있지 않습니다'는 만든 사람의 언어다.
 *   읽는 사람이 알아야 할 건 "무슨 일이 안 일어나고 있나"이지 어떤 부품이 없느냐가 아니다. */
function jobHealth(job: any, whatStops: string): Health | null {
  if (!job) return { level: 'off', line: `자동으로 ${whatStops} 일이 예약돼 있지 않습니다 — 설정을 해 둬도 아무 일도 일어나지 않습니다.` };
  if (!job.any_enabled) return { level: 'off', line: `자동으로 ${whatStops} 일이 꺼져 있습니다 — 켜야 돕니다.` };
  return null;
}

function collectHealth(s: any): Health {
  if (!s.configured) return { level: 'off', line: '가져오는 곳이 없습니다 — 슬랙·노션 같은 도구를 연결하면 그 내용이 자료로 들어옵니다.' };
  if (!s.enabled) return { level: 'off', line: `연결 ${s.configured}개가 모두 꺼져 있어 새 자료가 들어오지 않습니다.` };
  const j = jobHealth(s.job, '가져오는');
  if (j) return j;
  if (!s.recent_24h) return { level: 'note', line: '최근 24시간 동안 새로 들어온 자료가 없습니다.' };
  return { level: 'ok', line: `최근 24시간에 ${fmtNum(s.recent_24h)}건이 새로 들어왔습니다.` };
}

function distillHealth(s: any): Health {
  const j = jobHealth(s.job, '지식으로 바꾸는');
  // 잡이 꺼졌는데 밀린 자료가 있으면 그게 가장 급한 사실이다 — 문구에 함께 싣는다.
  if (j) return { ...j, line: j.line + (s.backlog ? ` 들어온 자료 ${fmtNum(s.backlog)}건이 지식이 못 된 채 쌓여 있습니다.` : '') };
  if (!s.configured) return { level: 'note', line: '무엇을 지식으로 남길지 정해 둔 기준이 없어, 전 자료를 한 기준으로 봅니다. 채널·팀마다 다르게 하려면 기준을 만드세요.' };
  if (!s.enabled) return { level: 'off', line: `지식으로 바꾸는 기준 ${s.configured}개가 모두 꺼져 있습니다.` };
  if (s.backlog > 1000) return { level: 'warn', line: `자료 ${fmtNum(s.backlog)}건이 아직 지식이 되지 못했습니다.` };
  if (s.backlog) return { level: 'note', line: `자료 ${fmtNum(s.backlog)}건이 지식이 되기를 기다립니다.` };
  return { level: 'ok', line: '밀린 자료가 없습니다.' };
}

function classifyHealth(s: any): Health {
  if (s.no_definition) {
    // 정의 없는 갈래가 있으면 그게 먼저다 — 자동 배정은 정의를 기준으로 판단하므로 정의가 비면 판단 근거가 없다.
    return { level: 'warn', line: `갈래 ${s.no_definition}개에 "무엇을 담는 갈래인지"가 비어 있습니다 — 설명이 없으면 AI 도 어디에 넣을지 알 수 없습니다.` };
  }
  const j = jobHealth(s.job, '갈래를 정하는');
  if (j) return { ...j, line: j.line + (s.backlog ? ` 갈래가 없는 지식 ${fmtNum(s.backlog)}건은 검색에도 안 잡힙니다.` : '') };
  const rest = s.backlog ? ` 갈래가 없는 지식 ${fmtNum(s.backlog)}건이 기다리고 있습니다.` : '';
  // ⚠ 규칙 대수를 여기서 말해야 한다 — 이 두 줄이 없어서 첫 화면은 "1시간마다 · 23분 전"이라 하고
  //  갈래 화면은 "아직 분류기가 없습니다"라고 했다. 둘 다 사실인데 합쳐 읽으면 모순이다(어니스트 실박스 지적).
  if (!s.configured) {
    // 규칙 0개는 '고장'이 아니다 — 기본 기준으로 떨어지는 게 설계된 폴백이다(무중단 계약 ④). 그래서 warn 이 아니라 note.
    return { level: 'note',
      line: `갈래를 자동으로 정하는 규칙이 없어 기본 기준 하나로 나눕니다 — 팀·주제마다 다르게 나누려면 규칙을 만드세요.${rest}` };
  }
  if (!s.enabled) {
    // 만들어 두고 다 꺼 둔 상태 — 일은 도는데 아무 규칙도 대상을 안 집는다(가장 헷갈리는 상태다).
    return { level: 'off', line: `갈래 배정 규칙 ${s.configured}개가 모두 꺼져 있습니다 — 아무 지식도 갈래를 받지 못합니다.${rest}` };
  }
  if (s.uncovered) return { level: 'warn', line: `어느 규칙에도 안 걸리는 지식이 ${fmtNum(s.uncovered)}건 있습니다 — 이대로면 영영 갈래를 못 받습니다.` };
  if (s.backlog) return { level: 'note', line: `갈래가 없는 지식 ${fmtNum(s.backlog)}건이 기다리고 있습니다.` };
  return { level: 'ok', line: '갈래가 없는 지식이 없습니다.' };
}

function manageHealth(s: any): Health {
  if (!s.configured) return { level: 'note', line: '자동 점검이 없습니다 — 갈래가 어긋난 지식, 근거보다 낡은 지식을 스스로 찾게 할 수 있습니다(비용 없음).' };
  if (!s.enabled) return { level: 'off', line: `자동 점검 ${s.configured}개가 모두 꺼져 있습니다.` };
  const j = jobHealth(s.job, '점검하는');
  if (j) return j;
  if (s.open.high) return { level: 'warn', line: `점검이 찾아낸 문제 ${fmtNum(s.open.high)}건이 중요로 표시돼 있습니다.` };
  if (s.open.total) return { level: 'note', line: `점검이 찾아낸 문제 ${fmtNum(s.open.total)}건이 아직 처리되지 않았습니다.` };
  return { level: 'ok', line: '처리할 것이 없습니다.' };
}

/** 네 단계의 판정 한 벌 — 현황 화면(context-home)이 '지금 할 일'을 만들 때 쓴다.
 *  ⚠ 판정 잣대는 이 파일의 *Health 함수 하나뿐이다 — 현황이 자기 임계를 따로 두면 두 화면이 서로 다른 말을 한다. */
export function pipelineHealths(d: any): Array<{ key: 'collect' | 'distill' | 'classify' | 'manage'; label: string; level: Health['level']; line: string }> {
  const s = (d && d.stages) || {};
  const mk = (key: any, label: string, h: Health | null) => ({ key, label, level: (h ? h.level : 'note') as Health['level'], line: h ? h.line : '' });
  return [
    mk('collect', '가져오기', s.collect ? collectHealth(s.collect) : null),
    mk('distill', '지식 만들기', s.distill ? distillHealth(s.distill) : null),
    mk('classify', '갈래 정하기', s.classify ? classifyHealth(s.classify) : null),
    mk('manage', '점검', s.manage ? manageHealth(s.manage) : null),
  ];
}

/** 네 단계의 판정 레벨만 — 상단 단계 탭(#1841, context.ts)이 점 색으로 쓴다. 판정 잣대는 위 *Health 함수 한 벌(카드와 같은 눈). */
export function stageHealthLevels(d: any): { collect: Health['level']; distill: Health['level']; classify: Health['level']; manage: Health['level'] } {
  const s = (d && d.stages) || {};
  const lv = (h: Health | null) => (h ? h.level : 'note');
  return {
    collect: s.collect ? lv(collectHealth(s.collect)) : 'note',
    distill: s.distill ? lv(distillHealth(s.distill)) : 'note',
    classify: s.classify ? lv(classifyHealth(s.classify)) : 'note',
    manage: s.manage ? lv(manageHealth(s.manage)) : 'note',
  };
}

/** 파이프라인 개요를 host 에 그린다. onGoto = 스테이지 클릭 시 서브탭 전환(라우터 대신 인메모리 전환). */
// ⚠ 옛 개요 UI(renderPipeline — 요약 배지 · 4단계 트랙 카드 · 게이트 · 자동 실행 줄)는 #1841 에서 **삭제**했다.
//  대체: web/context-home.ts(현황) — 같은 데이터를 '아는 것 + 할 일'로 말한다. 이 파일에는 **판정 함수만** 남는다
//  (한 벌의 잣대를 두 화면이 나눠 쓰던 구조는 유지 — 판정이 둘이 되면 화면끼리 다른 말을 한다).
