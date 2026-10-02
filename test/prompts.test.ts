import test from 'node:test';
import assert from 'node:assert/strict';

import { CODE_REVIEW_SYSTEM_PROMPT } from '../src/prompts/codeReview.js';

test('code review prompt includes repository context and comment tone guidance', () => {
    assert.match(CODE_REVIEW_SYSTEM_PROMPT, /제공된 diff와 PR 설명에서 확인/);
    assert.match(CODE_REVIEW_SYSTEM_PROMPT, /저장소 맥락/);
    assert.match(CODE_REVIEW_SYSTEM_PROMPT, /기본 톤은 부드러운 동료 리뷰/);
    assert.match(CODE_REVIEW_SYSTEM_PROMPT, /P3~P5/);
    assert.match(CODE_REVIEW_SYSTEM_PROMPT, /P1·P2/);
});

test('code review prompt treats server evidence as P1·P2 grounds but keeps unknown at P5 and ADD/REM anchors', () => {
    assert.match(CODE_REVIEW_SYSTEM_PROMPT, /\[REF-CALLER\]/);
    assert.match(CODE_REVIEW_SYSTEM_PROMPT, /P1·P2도 줄 수 있다/);
    assert.match(CODE_REVIEW_SYSTEM_PROMPT, /판정이 \\?`?unknown\\?`?인 심볼은 스니펫이 있어도 최대 P5/);
    assert.match(CODE_REVIEW_SYSTEM_PROMPT, /\[REF-CALLER\] 라인 번호는 diff 라인이 아니므로 line 값으로 쓰지 않는다/);
});

test('code review prompt keeps the P1~P5 JSON output contract', () => {
    for (const key of ['"changeSummary"', '"flowRisks"', '"testPoints"', '"comments"', '"severity": "P1 또는 P2 또는 P3 또는 P4 또는 P5"']) {
        assert.ok(CODE_REVIEW_SYSTEM_PROMPT.includes(key), key);
    }
    assert.doesNotMatch(CODE_REVIEW_SYSTEM_PROMPT, /MUST\(|SHOULD\(|BETTER\(|NITS\(/);
});

test('code review prompt uses CTX as context but anchors comments only to ADD/REM', () => {
    assert.match(CODE_REVIEW_SYSTEM_PROMPT, /CTX는 변경 맥락을 이해하기 위해 사용한다/);
    assert.match(CODE_REVIEW_SYSTEM_PROMPT, /comments는 반드시 ADD\/REM 라인에만 고정한다/);
    assert.match(CODE_REVIEW_SYSTEM_PROMPT, /"lineType": "ADDED 또는 REMOVED"/);
    assert.doesNotMatch(CODE_REVIEW_SYSTEM_PROMPT, /"lineType": "ADDED 또는 REMOVED 또는 CONTEXT"/);
});
