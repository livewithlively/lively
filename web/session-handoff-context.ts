// 하네스가 달라도 읽을 수 있는 최소 공통 대화 맥락을 만든다.
// 하네스별 원문·생각·도구 결과는 빼고, 사람이 한 말·AI 최종 답·도구 이름만 최신 순으로 제한해 넘긴다.
export interface SessionHandoffRecord {
  t: { text: string };
  evs: any[];
}

export const SESSION_HANDOFF_CONTEXT_MAX = 16_000;

export function sessionHandoffContext(records: readonly SessionHandoffRecord[], max = SESSION_HANDOFF_CONTEXT_MAX): string {
  const turns: string[] = [];
  for (const r of records) {
    const parts: string[] = [];
    if (r.t.text.trim()) parts.push(`사용자: ${r.t.text.trim()}`);
    const said: string[] = [];
    const tools: string[] = [];
    for (const ev of r.evs) {
      if (ev?.type !== 'assistant' || !Array.isArray(ev?.message?.content)) continue;
      for (const b of ev.message.content) {
        if (b?.type === 'text' && String(b.text || '').trim()) said.push(String(b.text).trim());
        else if (b?.type === 'tool_use' && b.name) tools.push(String(b.name));
      }
    }
    if (said.length) parts.push(`AI: ${said.join('\n')}`);
    if (tools.length) parts.push(`사용한 도구: ${Array.from(new Set(tools)).join(', ')}`);
    if (parts.length) turns.push(parts.join('\n'));
  }

  let out = '';
  for (let i = turns.length - 1; i >= 0; i--) {
    const next = turns[i] + (out ? `\n\n${out}` : '');
    if (next.length > max) break;
    out = next;
  }
  return out;
}
