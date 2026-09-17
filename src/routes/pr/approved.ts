import express from "express";
import { slackHooksCall } from "../../lib/slackWebhook.js";
import { slackWebhookUrlQa } from "../../config/env.js";
import { extractPrContext } from "../../services/codeReview/prReview.js";

const router = express.Router();

router.get("/health", (req, res) => {
    res.status(200).json({
        status: "healthy",
        timestamp: new Date().toISOString(),
        service: "bitbucket-webhook-pr-approved",
    });
});

router.post("/", async (req, res) => {
    const payload = req.body;
    const eventType = payload.eventKey;

    if (eventType !== 'pr:reviewer:approved') {
        if (payload.test) {
            console.log('⭐test');
            return res.status(200).send('test');
        }
        console.log('⭐️실패');
        return res.status(400).send('전송실패');
    }

    console.log('⭐️ approved');

    const ctx = extractPrContext(payload);

    const slackMessage = {
        text: "✅ PR이 승인되었습니다.",
        attachments: [
            {
                mrkdwn_in: ["text"],
                color: "#36a64f",
                title: `Pull request <${ctx.prUrl}|#${ctx.prID}> | (APPROVED)`,
                pretext: ctx.prUrl,
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
                        value: "",
                        short: false
                    },
                    {
                        value: ctx.prTitle || '',
                        short: false
                    },
                    {
                        title: "Description",
                        value: ctx.prDescription || '',
                        short: false
                    },
                    {
                        title: "Reviewers",
                        value: `<!here> ➡  <@${ctx.prUserId}> ${ctx.reviewerNameList.join(',')}`,
                        type: "code",
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
