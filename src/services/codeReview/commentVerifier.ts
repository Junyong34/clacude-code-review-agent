import type { ReviewComment } from '../../types/review.js';

export interface VerifyCommentsResult {
    verified: ReviewComment[];
    rejected: ReviewComment[];
}

/**
 * collectValidLineKeys()와 동일한 `file:line:lineType` 키 포맷을 코멘트 하나에서 만든다.
 */
export const buildCommentLineKey = (comment: ReviewComment): string =>
    `${comment.file}:${comment.line}:${comment.lineType}`;

/**
 * AI가 만든 인라인 코멘트가 실제 diff의 ADD/REM 라인에 근거하는지 게시 전에 코드로 확인한다.
 * lineType이 ADDED/REMOVED가 아니거나 키가 validLineKeys에 없으면 rejected로 분류한다.
 */
export const verifyComments = (
    comments: ReviewComment[],
    validLineKeys: Set<string>
): VerifyCommentsResult => {
    const verified: ReviewComment[] = [];
    const rejected: ReviewComment[] = [];

    for (const comment of comments) {
        const isReviewableLineType = comment.lineType === 'ADDED' || comment.lineType === 'REMOVED';
        const isValid = isReviewableLineType && validLineKeys.has(buildCommentLineKey(comment));
        (isValid ? verified : rejected).push(comment);
    }

    return { verified, rejected };
};
