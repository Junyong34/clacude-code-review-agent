import test from 'node:test';
import assert from 'node:assert/strict';

import {
    extractPrContext,
    isReReviewRequestComment,
    isTopLevelComment,
    shouldRunAutoReview,
} from '../../src/services/codeReview/prReview.js';
import { createPullRequestPayload } from '../helpers/fixtures.js';

test('extractPrContext preserves current Bitbucket payload mapping', () => {
    const ctx = extractPrContext(createPullRequestPayload());

    assert.equal(ctx.draft, false);
    assert.equal(ctx.prAuthor, 'Actor One');
    assert.equal(ctx.prUserId, 'actor1');
    assert.equal(ctx.prEmail, 'actor@example.test');
    assert.equal(ctx.prID, 123);
    assert.equal(ctx.prTitle, 'DEMO-1234 테스트 PR');
    assert.equal(ctx.prDescription, '테스트 설명');
    assert.equal(ctx.prFromBr, 'feature/demo-1234');
    assert.equal(ctx.prToBr, 'master');
    assert.deepEqual(ctx.reviewerNameList, ['<@reviewer1>']);
    assert.equal(ctx.repoName, 'example-app');
    assert.equal(ctx.prUrl, 'https://bitbucket.example.test/projects/DEMO/repos/example-app/pull-requests/123');
    assert.equal(ctx.isPrd, true);
    assert.equal(ctx.isQa, false);
});

test('shouldRunAutoReview keeps master non-draft as the only auto review target', () => {
    const masterContext = extractPrContext(createPullRequestPayload());
    const draftContext = { ...masterContext, draft: true };
    const qaContext = extractPrContext(createPullRequestPayload({
        pullRequest: {
            ...createPullRequestPayload().pullRequest,
            toRef: {
                displayId: 'release/release',
                repository: { name: 'example-app' },
            },
        },
    }));

    assert.equal(shouldRunAutoReview(masterContext), true);
    assert.equal(shouldRunAutoReview(draftContext), false);
    assert.equal(shouldRunAutoReview(qaContext), false);
});

test('isTopLevelComment only accepts comments without parent or anchor', () => {
    assert.equal(isTopLevelComment({ text: 'top-level' }), true);
    assert.equal(isTopLevelComment({ text: 'reply', parent: { id: 1 } }), false);
    assert.equal(isTopLevelComment({ text: 'inline', anchor: { path: 'src/app.ts' } }), false);
    assert.equal(isTopLevelComment(null), false);
});

test('isReReviewRequestComment requires bot mention and re-review keyword text', () => {
    assert.equal(isReReviewRequestComment('@review-bot 재리뷰 해줘', 'review-bot'), true);
    assert.equal(isReReviewRequestComment('[~review-bot] 재리뷰 부탁해', 'review-bot'), true);
    assert.equal(isReReviewRequestComment('@review-bot 확인해줘', 'review-bot'), false);
    assert.equal(isReReviewRequestComment('[~review-bot] lgtm?', 'review-bot'), false);
    assert.equal(isReReviewRequestComment('재리뷰 해줘', 'review-bot'), false);
    assert.equal(isReReviewRequestComment('@other-bot 재리뷰', 'review-bot'), false);
});
