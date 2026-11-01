// 증류를 손으로 돌리기 직전의 확인(#5235) — 「지금 한 번 실행」 · 「지금 수집·증류」 가 함께 쓴다.
//
//  레인을 지정하지 않은 증류 잡은 맡은 증류기가 없는 자료도 기본 기준으로 함께 낸다(#1631 — 반만 켜도 나머지가 굶지 않게 한 의도된 동작).
//  문제는 그것을 **누른 뒤에야** 알 수 있었다는 것이다. 증류기 하나를 시범으로 돌렸는데 맡은 증류기가 없는 자료 50건이 붙어 나가
//  손으로 취소한 일이 있었다(고객사 첫 세팅). 그래서 누르기 전에 서버의 실행 판정을 그대로 읽어(dry_run), 기본 기준으로 나갈 자료가 있을 때만 묻는다.
//  무엇을 물을지는 lib/distill-run-ask.ts(순수 규칙), 여기는 그 답대로 창을 그린다.
import { api, el, fmtNum } from './core.js';
import { confirmDialog } from './ui-primitives.js';
import { distillRunAsk } from './lib/distill-run-ask.js';

/**
 * 실행 요청에 얹을 값을 돌려준다 — `{}` 면 그대로 실행, `{ lanes_only: true }` 면 증류기 몫만, null 이면 사람이 멈췄다.
 *  미리 보기를 못 읽으면 던진다. 무엇이 나갈지 모른 채 실행하지 않는다(부르는 쪽이 실패로 알린다).
 */
export async function confirmDistillRun(jobId: string): Promise<{ lanes_only?: true } | null> {
  const r: any = await api(`/api/ui/cron/${encodeURIComponent(jobId)}/run`, { method: 'POST', body: JSON.stringify({ dry_run: true }) });
  const a = distillRunAsk(r?.plan);
  if (a.ask === 'none') return {};
  const restLine = a.rest ? [`남은 ${fmtNum(a.rest)}건은 다음 실행부터 이어서 나갑니다.`] : [];

  if (a.ask === 'default-only') {
    const ok = await confirmDialog({
      title: `기본 기준으로 자료 ${fmtNum(a.sources)}건을 지식으로 만듭니다`,
      message: '맡은 증류기가 없는 자료입니다. 증류기의 기준이 아니라 기본 기준으로 지식이 됩니다.',
      lines: restLine, confirmText: '실행',
    });
    return ok ? {} : null;
  }

  //  기본값은 끈 채다 — 읽지 않고 [실행] 을 눌러도 증류기 몫만 나간다.
  const withRest = el('input', { type: 'checkbox', id: 'distill-run-unassigned' }) as HTMLInputElement;
  const ok = await confirmDialog({
    title: `맡은 증류기가 없는 자료 ${fmtNum(a.sources)}건이 있습니다`,
    message: '함께 실행하면 이 자료는 증류기의 기준이 아니라 기본 기준으로 지식이 됩니다.',
    lines: [`증류기 ${fmtNum(a.laneCount)}개가 자료 ${fmtNum(a.laneSources)}건을 읽습니다.`, ...restLine],
    extra: el('label', { class: 'ov-confirm-opt', for: 'distill-run-unassigned' }, withRest,
      el('span', { class: 'n', text: '맡은 증류기가 없는 자료도 함께 실행합니다' }),
      el('span', { class: 'h', text: '끄면 증류기 몫만 실행합니다' })),
    confirmText: '실행',
  });
  if (!ok) return null;
  return withRest.checked ? {} : { lanes_only: true };
}
