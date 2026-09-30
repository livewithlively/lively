import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const chat = readFileSync(new URL('../web/chat-view.ts', import.meta.url), 'utf8');
const session = readFileSync(new URL('../web/session-chat.ts', import.meta.url), 'utf8');

assert.match(chat, /canSendEmpty/, '첨부만 있는 메시지도 전송할 수 있어야 한다');
assert.match(chat, /opts\.compose\?\.chips/, '첨부 칩은 대화 입력 form 안에 있어야 한다');
assert.match(session, /composerAttach\(\{ projectId: \(\) => Number\(target\.projectId\) \|\| 0 \}\)/, '세션의 프로젝트 폴더 또는 개인 uploads/에 첨부해야 한다');
assert.match(session, /attachments\.wirePaste\(view\.input\)/, '채팅 입력칸의 이미지 붙여넣기를 업로드로 처리해야 한다');
assert.match(session, /text \+ attachments\.tail\(\)/, '보낸 지시에 노드 무관 첨부 좌표를 함께 실어야 한다');
assert.match(session, /attachments\.busy\(\)/, '업로드가 끝나기 전에는 전송하면 안 된다');

console.log('ok — session chat attachments');
