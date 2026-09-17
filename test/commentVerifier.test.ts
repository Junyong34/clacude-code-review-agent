import test from 'node:test';
import assert from 'node:assert/strict';

import { buildCommentLineKey, verifyComments } from '../src/services/codeReview/commentVerifier.js';
import type { ReviewComment } from '../src/types/review.js';

const comment = (overrides: Partial<ReviewComment> = {}): ReviewComment => ({
    file: 'src/a.ts',
    line: 10,
    lineType: 'ADDED',
    severity: 'P3',
    text: '테스트 코멘트',
    ...overrides,
});

test('buildCommentLineKey: collectValidLineKeys와 동일한 file:line:lineType 포맷을 만든다', () => {
    assert.equal(buildCommentLineKey(comment({ file: 'src/a.ts', line: 10, lineType: 'ADDED' })), 'src/a.ts:10:ADDED');
});

test('verifyComments: 유효한 키는 verified로, 무효한 키는 rejected로 분리한다', () => {
    const validLineKeys = new Set(['src/a.ts:10:ADDED', 'src/b.ts:5:REMOVED']);
    const comments = [
        comment({ file: 'src/a.ts', line: 10, lineType: 'ADDED' }),
        comment({ file: 'src/b.ts', line: 5, lineType: 'REMOVED' }),
        comment({ file: 'src/c.ts', line: 99, lineType: 'ADDED' }),
    ];

    const { verified, rejected } = verifyComments(comments, validLineKeys);

    assert.equal(verified.length, 2);
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].file, 'src/c.ts');
});

test('verifyComments: lineType이 ADDED/REMOVED가 아니면 키가 있어도 rejected다', () => {
    const validLineKeys = new Set(['src/a.ts:10:CONTEXT']);
    const comments = [comment({ file: 'src/a.ts', line: 10, lineType: 'CONTEXT' })];

    const { verified, rejected } = verifyComments(comments, validLineKeys);

    assert.equal(verified.length, 0);
    assert.equal(rejected.length, 1);
});

test('verifyComments: 빈 comments 배열은 빈 결과를 반환한다', () => {
    const { verified, rejected } = verifyComments([], new Set());
    assert.deepEqual(verified, []);
    assert.deepEqual(rejected, []);
});
