import test from 'node:test';
import assert from 'node:assert/strict';

import { buildCrgOnlyComment, isReReviewRequestComment } from '../src/services/codeReview/prReview.js';

test('isReReviewRequestComment: bot 멘션과 재리뷰 키워드가 있으면 true', () => {
    assert.equal(isReReviewRequestComment('@mybot 재리뷰 해줘', 'mybot'), true);
    assert.equal(isReReviewRequestComment('[~mybot] 재리뷰 부탁해', 'mybot'), true);
});

test('isReReviewRequestComment: 재리뷰 키워드 없으면 bot 멘션이어도 false', () => {
    assert.equal(isReReviewRequestComment('@mybot lgtm?', 'mybot'), false);
    assert.equal(isReReviewRequestComment('[~mybot] 봐줘', 'mybot'), false);
});

test('isReReviewRequestComment: bot 멘션 없으면 false', () => {
    assert.equal(isReReviewRequestComment('재리뷰 해줘', 'mybot'), false);
    assert.equal(isReReviewRequestComment('', 'mybot'), false);
    assert.equal(isReReviewRequestComment('@otherbot 재리뷰', 'mybot'), false);
});

test('buildCrgOnlyComment: Claude 완료 시그니처 없이 CRG 결과만 표시한다', () => {
    const comment = buildCrgOnlyComment({
        draft: false,
        prID: 24541,
        prFromBr: 'feature/test',
        prToBr: 'master',
        prReviewers: [],
        reviewerNameList: [],
        repoName: 'example-app',
        prUrl: 'https://bitbucket.example.test/pr/24541',
        isPrd: true,
        isQa: false,
    }, 13, '### 함께 확인해 주세요\n\n이번 PR에서 수정된 항목을 참조하지만, 이번 PR에서는 변경되지 않은 파일입니다.\n이번 변경으로 인해 아래 참조 파일에도 수정이 필요한 부분이 없는지 확인해 주세요.\n\n- `src/Consumer.tsx`\n  - 참조 항목: **CouponComponent** (`src/Coupon.tsx`)');

    assert.match(comment, /CRG 분석 결과/);
    assert.match(comment, /변경 파일: 13개/);
    assert.match(comment, /CouponComponent/);
    assert.doesNotMatch(comment, /🤖 AI Re-Review/);
    assert.doesNotMatch(comment, /🤖 AI Code Review/);
});

test('buildCrgOnlyComment: 참조 결과가 없으면 없음으로 표시한다', () => {
    const comment = buildCrgOnlyComment({
        draft: false,
        prID: 1,
        prFromBr: 'feature/test',
        prToBr: 'master',
        prReviewers: [],
        reviewerNameList: [],
        repoName: 'example-app',
        prUrl: '',
        isPrd: true,
        isQa: false,
    }, 0, '');

    assert.match(comment, /### 호출부 확인 결과\n\n외부 인터페이스 변경으로 확인이 필요한 참조 파일은 없습니다\./);
});
