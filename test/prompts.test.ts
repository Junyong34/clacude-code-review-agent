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

test('code review prompt uses CTX as context but anchors comments only to ADD/REM', () => {
    assert.match(CODE_REVIEW_SYSTEM_PROMPT, /CTX는 변경 맥락을 이해하기 위해 사용한다/);
    assert.match(CODE_REVIEW_SYSTEM_PROMPT, /comments는 반드시 ADD\/REM 라인에만 고정한다/);
    assert.match(CODE_REVIEW_SYSTEM_PROMPT, /"lineType": "ADDED 또는 REMOVED"/);
    assert.doesNotMatch(CODE_REVIEW_SYSTEM_PROMPT, /"lineType": "ADDED 또는 REMOVED 또는 CONTEXT"/);
});
