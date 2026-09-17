import { formatPrTitle } from '../../lib/prTitle.js';
import express from "express";
import { slackHooksCall } from "../../lib/slackWebhook.js";
import { slackWebhookUrlPrd, slackWebhookUrlQa } from "../../config/env.js";
import { extractPrContext } from "../../services/codeReview/prReview.js";


const router = express.Router();

router.get("/health", (req, res) => {
    res.status(200).json({
        status: "healthy",
        timestamp: new Date().toISOString(),
        service: "bitbucket-webhook-pr-merged",
    });
});

router.post("/", async (req, res) => {
    const payload = req.body;
    const eventType = payload.eventKey;

    if (eventType !== 'pr:merged') {
        if (payload.test) {
            console.log('⭐test');
            return res.status(200).send('test');
        }
        console.log('⭐️실패');
        return res.status(400).send('전송실패');
    }

    console.log('⭐️ merged');

    const ctx = extractPrContext(payload);

    if (ctx.isQa) {
        return res.status(200).send('QA');
    }

    if (ctx.prReviewers.length === 0) {
        return res.status(200).send('리뷰어가 없음');
    }

    const slackMessage = {
        text: "✅ merge 되었습니다.",
        attachments: [
            {
                mrkdwn_in: ["text"],
                color: "#36a64f",
                title: `Pull request <${ctx.prUrl}|#${ctx.prID}> | (MERGED) (${ctx.repoName} ☑️)`,
                author_name: `by ${ctx.prUserId} / ${ctx.prAuthor}`,
                author_email: ctx.prEmail,
                author_icon: "https://cdn1.iconfinder.com/data/icons/logos-1/24/developer-community-github-1024.png",
                fields: [
                    {
                        value: `\`${ctx.prFromBr}\`  →  \`${ctx.prToBr}\``,
                        type: "code",
                        short: false
                    },
                    {
                        title: "Title",
                        value: `${formatPrTitle(ctx.prTitle || '')} `,
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

    const slackUrl = ctx.isPrd ? slackWebhookUrlPrd : slackWebhookUrlQa;
    const result = await slackHooksCall(slackUrl, slackMessage);
    res.status(result.status).send(result.data);
});

export default router;
