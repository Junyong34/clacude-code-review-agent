import express from "express";
import { BITBUCKET_BOT_SLUG } from "../../config/env.js";
import { BOT_REREVIEW_SIGNATURE } from "../../prompts/codeReview.js";
import { buildReviewOverviewMarkdown } from "../../services/codeReview/reviewOutput.js";
import { extractPrContext, isReReviewRequestComment, isTopLevelComment, runCodeReview } from "../../services/codeReview/prReview.js";

// PR top-level comment 중 bot 멘션(`@bot` 또는 `[~bot]`)과 `재리뷰` 문구가 있으면 수동 AI 재리뷰를 트리거하는 라우터.
// 리뷰 시작 Slack 알림은 reviewers 라우터에서 별도로 처리한다.
// PR당 1회 제한 없이, 매번 `@bot 재리뷰` 요청이 오면 그때마다 재리뷰를 실행한다.

const router = express.Router();

router.get('/health', (req, res) => {
    res.status(200).json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        service: 'bitbucket-webhook-pr-comment',
    });
});

router.post('/', async (req, res) => {
    const payload = req.body;

    if (payload.eventKey !== 'pr:comment:added' || !payload.pullRequest) {
        if (payload.test) {
            console.log('⭐test');
            return res.status(200).send('test');
        }

        return res.status(200).send('ok');
    }

    const ctx = extractPrContext(payload);
    const comment = payload.comment;
    const commentText = comment?.text || '';

    if (!BITBUCKET_BOT_SLUG) {
        console.error('[code-review] BITBUCKET_BOT_SLUG가 설정되지 않아 재리뷰 요청을 무시합니다.');
        return res.status(200).send('bot slug 없음');
    }

    console.log(`[re-review] 코멘트 수신 | prId=${ctx.prID} | user=${ctx.prUserId} | text="${commentText}"`);
    console.log(`[re-review] isTopLevel=${isTopLevelComment(comment)} | anchor=${!!comment?.anchor} | parent=${!!comment?.parent}`);

    if (!isTopLevelComment(comment)) {
        console.log('[re-review] 스킵: inline/anchor 코멘트');
        return res.status(200).send('inline comment');
    }

    if (ctx.prUserId === BITBUCKET_BOT_SLUG) {
        console.log('[re-review] 스킵: 봇 자신의 코멘트');
        return res.status(200).send('bot comment');
    }

    const hasBotMention = commentText.includes(`@${BITBUCKET_BOT_SLUG}`) || commentText.includes(`[~${BITBUCKET_BOT_SLUG}]`);
    const hasReReviewKeyword = commentText.includes('재리뷰');
    console.log(`[re-review] 봇멘션=${hasBotMention} | 재리뷰키워드=${hasReReviewKeyword} | BOT_SLUG="${BITBUCKET_BOT_SLUG}"`);

    if (!isReReviewRequestComment(commentText, BITBUCKET_BOT_SLUG)) {
        return res.status(200).send('재리뷰 조건 아님');
    }

    res.status(200).send('재리뷰 요청 접수');

    void (async () => {
        await runCodeReview(ctx, {
            signature: BOT_REREVIEW_SIGNATURE,
            skipIfAlreadyReviewed: false,
            sendSlack: true,
            enableLocalVerification: true,
            enableSymbolReferenceHints: true,
            buildFinalComment: ({ reviewData, comments, signature, truncatedNote, verificationNote, symbolReferenceMarkdown }) => {
                const inlineNote = comments.length > 0
                    ? `인라인 코멘트 ${comments.length}개를 작성했습니다.`
                    : '남길 인라인 코멘트는 없었습니다.';
                const symbolReferenceSection = symbolReferenceMarkdown ? `\n\n${symbolReferenceMarkdown}` : '';
                return `${signature}\n\n재리뷰가 완료되었습니다.\n\n${buildReviewOverviewMarkdown(reviewData)}${symbolReferenceSection}\n\n${inlineNote}${verificationNote}${truncatedNote}`;
            }
        });
    })().catch((error) => console.error('[code-review] 오류:', error.message));

    return undefined;
});

export default router;
