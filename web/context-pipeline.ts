// context-pipeline.ts — 맥락 파이프라인 개요(#1419 T6). [맥락 관리] 탭의 첫 화면.
//  #4194 — 단계는 셋(수집·증류·관리)이다. 종전 «분류» 단계는 증류기의 카테고리 붙이기 레인이 됐고(distillHealth 가 두 레인을
//   함께 판정한다), 카테고리 칸 자체의 건강(정의 빈 칸)은 단계가 아니라 기준표로 따로 잰다(taxonomyHealth).
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

/** 판정 등급의 무게 — 둘을 합칠 때 더 급한 쪽을 앞세운다(멈춤 > 확인 필요 > 참고 > 정상). */
const WEIGHT: Record<Health['level'], number> = { off: 3, warn: 2, note: 1, ok: 0 };

/**
 * 증류 단계 = 자료 레인 + 카테고리 붙이기 레인(#4194 — 종전 «분류» 단계가 이 레인이 됐다).
 *  두 판정 중 더 급한 쪽의 등급을 쓰고, 둘 다 할 말이 있으면 **급한 쪽 문장을 앞에** 이어 붙인다 —
 *  하나만 말하면 다른 레인이 멈춘 사실이 화면에서 사라진다(탭 점·흐름 지도·확인할 것이 같은 잣대를 쓴다).
 */
function distillHealth(d: any): Health {
  const s = (d && d.stages && d.stages.distill) || {};
  const a = sourceLaneHealth(s);
  const k = fillStage(d);
  const b = k ? fillLaneHealth(k) : null;
  if (!b || b.level === 'ok') return a;
  if (a.level === 'ok') return b;
  const [first, second] = WEIGHT[b.level] > WEIGHT[a.level] ? [b, a] : [a, b];
  return { level: first.level, line: first.line + ' ' + second.line };
}

/** 자료 레인 — 자료가 지식이 되는 쪽. */
function sourceLaneHealth(s: any): Health {
  const j = jobHealth(s.job, '지식으로 바꾸는');
  // 잡이 꺼졌는데 밀린 자료가 있으면 그게 가장 급한 사실이다 — 문구에 함께 싣는다.
  if (j) return { ...j, line: j.line + (s.backlog ? ` 들어온 자료 ${fmtNum(s.backlog)}건이 지식이 못 된 채 쌓여 있습니다.` : '') };
  if (!s.configured) return { level: 'note', line: '무엇을 지식으로 남길지 정해 둔 기준이 없어, 전 자료를 한 기준으로 봅니다. 채널·팀마다 다르게 하려면 기준을 만드세요.' };
  //  전부 꺼 둔 것은 «멈춤» 이 아니다 — 켜진 증류기가 없으면 크론이 전 자료를 기본 기준 하나로 본다(distill.ts 폴백).
  //   종전 «모두 꺼져 있습니다»(off)는 사실과 반대로 읽혔다(#4194 적대검증). 멈추려면 자동 실행을 끈다.
  if (!s.enabled) return { level: 'note', line: `켜 둔 증류기가 없어 전 자료를 기본 기준 하나로 봅니다(만든 것 ${s.configured}개는 꺼짐). 채널·팀마다 다르게 하려면 켜세요 — 아예 멈추려면 자동 실행을 끄세요.` };
  if (s.backlog > 1000) return { level: 'warn', line: `자료 ${fmtNum(s.backlog)}건이 아직 지식이 되지 못했습니다.` };
  if (s.backlog) return { level: 'note', line: `자료 ${fmtNum(s.backlog)}건이 지식이 되기를 기다립니다.` };
  return { level: 'ok', line: '밀린 자료가 없습니다.' };
}

/** 카테고리 붙이기 수치 — 새 모양(stages.distill.knowledge), 없으면 옛 모양(stages.classify — 배포 중 옛 게이트웨이). */
function fillStage(d: any): any {
  const st = (d && d.stages) || {};
  return (st.distill && st.distill.knowledge) || st.classify || null;
}
/** 카테고리 칸 수치 — 새 모양(taxonomy), 없으면 옛 모양(stages.classify 의 categories·no_definition). */
function taxonomyOf(d: any): any {
  if (d && d.taxonomy) return d.taxonomy;
  const c = d && d.stages && d.stages.classify;
  return c ? { categories: c.categories, no_definition: c.no_definition } : null;
}

/**
 * 카테고리 붙이기 — 미분류 지식(노션 같은 지식 직행 수집 등)에 카테고리를 붙이는 쪽(#4194, 종전 «분류» 단계).
 *  ⚠ 할 일이 없으면(미분류 지식 0) 증류기 0개·자동 실행 없음도 **말하지 않는다** — 대부분의 조직은 이 쪽이 쉴 일이 많고,
 *   증류 탭 점이 늘 «참고» 로 켜져 있으면 점이 신호가 아니라 장식이 된다. 판정은 밀린 것이 있을 때 한다(온보딩 stuckStages 와 같은 조건).
 */
function fillLaneHealth(s: any): Health {
  const n = Number(s.backlog || 0);
  if (!n) return { level: 'ok', line: '' };
  const rest = ` 미분류 지식 ${fmtNum(n)}건은 검색에도 안 잡힙니다.`;
  const j = jobHealth(s.job, '카테고리를 붙이는');
  if (j) return { ...j, line: j.line + rest };
  // ⚠ 증류기 대수를 여기서 말해야 한다 — 종전 화면은 첫 화면에 "1시간마다 · 23분 전", 설정 화면에 "아직 분류기가 없습니다"가 동시에 떠
  //  둘 다 사실인데 합쳐 읽으면 모순이었다(어니스트 실박스 지적). 켜진 것 0개는 고장이 아니라 설계된 폴백(기본 기준 하나)이다 —
  //  **전부 꺼 둔 것도 같다**(classify.ts: 일하는 레인이 없으면 레거시 전역 경로). 종전 «모두 꺼져 있습니다 · 그대로 남습니다»(off)는 거짓이었다.
  if (!s.enabled) return { level: 'note', line: `미분류 지식 ${fmtNum(n)}건에 기본 기준 하나로 카테고리를 붙이고 있습니다 — 출처·팀마다 기준을 나누려면 카테고리 붙이기 증류기를 만들거나 켜세요.` };
  if (s.uncovered) return { level: 'warn', line: `켜진 카테고리 붙이기 증류기 어디에도 안 걸리는 지식이 ${fmtNum(s.uncovered)}건 있습니다 — 이대로면 영영 카테고리가 안 붙습니다.` };
  return { level: 'note', line: `미분류 지식 ${fmtNum(n)}건에 카테고리가 붙기를 기다립니다.` };
}

/** 카테고리(기준표) — 단계가 아니라 증류가 고를 칸이자 점검의 잣대. 칸이 없으면 새 지식을 아예 저장할 수 없다(카테고리 필수). */
function taxonomyHealth(t: any): Health {
  if (t && Number(t.categories) === 0) {
    return { level: 'warn', line: '카테고리가 하나도 없습니다 — 새 지식은 카테고리가 있어야 저장되므로, 증류기도 AI 도 지식을 남길 수 없습니다.' };
  }
  if (t && t.no_definition) {
    return { level: 'warn', line: `카테고리 ${t.no_definition}개에 "무엇을 담는 칸인지"가 비어 있습니다 — 설명이 없으면 AI 도 어디에 넣을지 알 수 없습니다.` };
  }
  return { level: 'ok', line: '모든 카테고리에 정의가 있습니다.' };
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

/** 판정 레벨만 — 상단 탭(#1841, context.ts)이 점 색으로 쓴다. 판정 잣대는 위 *Health 함수 한 벌(카드와 같은 눈). */
export function stageHealthLevels(d: any): { collect: Health['level']; distill: Health['level']; taxonomy: Health['level']; manage: Health['level'] } {
  const h = stageHealthDetails(d);
  return { collect: h.collect.level, distill: h.distill.level, taxonomy: h.taxonomy.level, manage: h.manage.level };
}

/** 판정 등급 + **그 문장** — 탭 점의 툴팁이 쓴다(#4194 적대검증: 증류 점이 빨개도 그게 자료 쪽인지 카테고리 붙이기 쪽인지
 *  화면 어디에도 안 나왔다 — 합친 판정의 문장은 살아 있는 화면에 닿지 않고 있었다). */
export function stageHealthDetails(d: any): Record<'collect' | 'distill' | 'taxonomy' | 'manage', Health> {
  const s = (d && d.stages) || {};
  const none: Health = { level: 'note', line: '' };
  const tx = taxonomyOf(d);
  return {
    collect: s.collect ? collectHealth(s.collect) : none,
    distill: s.distill ? distillHealth(d) : none,
    taxonomy: tx ? taxonomyHealth(tx) : none,
    manage: s.manage ? manageHealth(s.manage) : none,
  };
}

/** 파이프라인 개요를 host 에 그린다. onGoto = 스테이지 클릭 시 서브탭 전환(라우터 대신 인메모리 전환). */
// ⚠ 옛 개요 UI(renderPipeline — 요약 배지 · 4단계 트랙 카드 · 게이트 · 자동 실행 줄)는 #1841 에서 **삭제**했다.
//  대체: 흐름 지도(web/context-map.ts, #762 — 그 사이의 web/context-home.ts 는 #4194 에서 지웠다). 이 파일에는 **판정 함수만** 남는다
//  (한 벌의 잣대를 두 화면이 나눠 쓰던 구조는 유지 — 판정이 둘이 되면 화면끼리 다른 말을 한다).
