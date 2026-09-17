import express from "express";
import { slackHooksCall } from "../../lib/slackWebhook.js";
import { slackWebhookUrlQa, BITBUCKET_BOT_SLUG } from "../../config/env.js";
import { BOT_REREVIEW_SIGNATURE } from "../../prompts/codeReview.js";
import { buildReviewOverviewMarkdown } from "../../services/codeReview/reviewOutput.js";
import { extractPrContext, isReReviewRequestComment, isTopLevelComment, runCodeReview } from "../../services/codeReview/prReview.js";

// 이름은 reviewers 이지만 실제로는 pr:comment:added 이벤트를 받아 리뷰 시작 Slack 알림을 보낸다.
// `@bot 재리뷰` 요청은 Slack 알림 전에 감지해 수동 AI 재리뷰로 처리한다.
// PR당 1회 제한 없이, 매번 요청이 오면 그때마다 재리뷰를 실행한다.

const router = express.Router();

router.post("/", async (req, res) => {
    const payload = req.body;
    const eventType = payload.eventKey;

    if (eventType !== 'pr:comment:added') {
        if (payload.test) {
            console.log('⭐test');
            return res.status(200).send('test');
        }
        console.log('⭐️실패');
        return res.status(400).send('전송실패');
    }

    const ctx = extractPrContext(payload);
    const comment = payload.comment;
    const commentText = comment?.text || '';
    const prAuthorName = payload.pullRequest.author.user.displayName;
    const prAuthorSlug = payload.pullRequest.author.user.name;

    console.log('⭐️ prCommentUserId =>', ctx.prUserId, prAuthorName, prAuthorSlug);

    // 재리뷰 요청 처리
    if (
        BITBUCKET_BOT_SLUG &&
        isTopLevelComment(comment) &&
        ctx.prUserId !== BITBUCKET_BOT_SLUG &&
        isReReviewRequestComment(commentText, BITBUCKET_BOT_SLUG)
    ) {
        res.status(200).send('재리뷰 요청 접수');

        void (async () => {
            await runCodeReview(ctx, {
                signature: BOT_REREVIEW_SIGNATURE,
                skipIfAlreadyReviewed: false,
                sendSlack: false,
                enableLocalVerification: true,
                enableSymbolReferenceHints: true,
                buildFinalComment: ({ reviewData, comments, truncatedNote, verificationNote, symbolReferenceMarkdown }) => {
                    const inlineNote = comments.length > 0
                        ? `인라인 코멘트 ${comments.length}개를 작성했습니다.`
                        : '남길 인라인 코멘트는 없었습니다.';
                    const symbolReferenceSection = symbolReferenceMarkdown ? `\n\n${symbolReferenceMarkdown}` : '';
                    return `${BOT_REREVIEW_SIGNATURE}\n\n재리뷰가 완료되었습니다.\n\n${buildReviewOverviewMarkdown(reviewData)}${symbolReferenceSection}\n\n${inlineNote}${verificationNote}${truncatedNote}`;
                }
            });
        })().catch((error) => console.error('[re-review] 오류:', error));

        return undefined;
    }

    if (ctx.prReviewers.length === 0) {
        return res.status(200).send('리뷰어가 없음');
    }

    const slackMessage = {
        text: "Reviewer가 리뷰를 시작했습니다. 👀",
        attachments: [
            {
                mrkdwn_in: ["text"],
                color: "#5468e3",
                title: `Start review <${ctx.prUrl}|#${ctx.prID}> (${ctx.repoName} ☑️)`,
                author_name: `by ${prAuthorName} / ${prAuthorSlug}`,
                author_icon: "https://cdn1.iconfinder.com/data/icons/logos-1/24/developer-community-github-1024.png",
                fields: [
                    {
                        value: `\`${ctx.prAuthor}\`  →  <@${prAuthorSlug}>`,
                        type: "code",
                        short: false
                    },
                    {
                        title: "comment ✏️",
                        value: `${commentText} `,
                        short: false
                    },
                ],
                thumb_url: "https://cdn.icon-icons.com/icons2/2108/PNG/512/bitbucket_icon_130979.png",
                footer: "bitbucket",
                footer_icon: "https://cdn.icon-icons.com/icons2/2108/PNG/512/bitbucket_icon_130979.png",
                ts: Math.floor(new Date().getTime() / 1000)
            }
        ]
    };

    const result = await slackHooksCall(slackWebhookUrlQa, slackMessage);
    res.status(result.status).send(result.data);
});

export default router;
