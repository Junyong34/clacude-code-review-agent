import { DEPLOY_CHECKLIST_URL } from '../../config/env.js';
import { slackHooksCall } from '../../lib/slackWebhook.js';
import type { BitbucketOpenPullRequest } from '../../types/bitbucket.js';
import type { SlackAttachment, SlackMessage } from '../../types/slack.js';

// Target Users
const TARGET_USERS = process.env.SLACK_TARGET_USERS
    ? process.env.SLACK_TARGET_USERS.split(',')
    : [];
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL_PRD;


/**
 * Daily PR reminder Slack 메시지를 전송한다.
 * 배포 대상 PR이 있으면 PR 목록 attachment를 포함하고, 없으면 확인 요청 메시지만 보낸다.
 */
export const sendDailyPRNotification = async (prs?: BitbucketOpenPullRequest[]): Promise<void> => {
    const prCount = prs ? prs.length : 0;
    const hasPRs = prCount > 0;

    const attachments: SlackAttachment[] = hasPRs ? (prs as BitbucketOpenPullRequest[]).map(pr => {
        return {
            color: "#36a64f",
            title: `${pr.title}`,
            title_link: pr.links?.self?.[0]?.href || '#',
            author_name: pr.author?.user?.displayName || 'Unknown',
            fields: [
                {
                    title: "Branch",
                    value: `\`${(pr.fromRef as { displayId: string }).displayId}\`  →  \`${(pr.toRef as { displayId: string }).displayId}\``,
                    type: "mrkdwn",
                    short: false
                }
            ],
            "thumb_url": "https://cdn.icon-icons.com/icons2/2108/PNG/512/bitbucket_icon_130979.png",
            "footer": "bitbucket",
            "footer_icon": "https://cdn.icon-icons.com/icons2/2108/PNG/512/bitbucket_icon_130979.png",
            ts: Math.floor(new Date().getTime() / 1000)
        };
    }) : [];

    const mainText = hasPRs
        ? `📢 *Daily PR Reminder* 📢\n 배포 나가는 PR이 \`${prCount}\`건 있습니다.${DEPLOY_CHECKLIST_URL ? `\n배포 체크리스트: ${DEPLOY_CHECKLIST_URL}` : ''}\nCC: ${TARGET_USERS.join(' ')}`
        : `📢 *Daily PR Reminder* 📢\n 오늘 배포 예정인 건이 있는지 확인해주세요.${DEPLOY_CHECKLIST_URL ? `\n배포 체크리스트: ${DEPLOY_CHECKLIST_URL}` : ''}\nCC: ${TARGET_USERS.join(' ')}`;

    const message: SlackMessage = {
        text: hasPRs ? `📢 *Daily PR Reminder* 📢\n 배포 나가는 PR이 \`${prCount}\`건 있습니다.` : `📢 *Daily PR Reminder* 📢\n 오늘 배포 예정인 건이 있는지 확인해주세요.`,
        blocks: [
            {
                type: "section",
                text: {
                    type: "mrkdwn" as const,
                    text: mainText
                }
            },
            ...(hasPRs ? [{
                type: "context",
                elements: [
                    {
                        type: "mrkdwn" as const,
                        text: "⚠️ PR 건수랑 실제 배포 건수랑 차이가 있을수 있습니다. 배포 체크리스트도 꼭 확인해주세요"
                    }
                ]
            }] : [])
        ],
        attachments: attachments
    };

    const result = await slackHooksCall(SLACK_WEBHOOK_URL, message);
    if (result.status !== 200) {
        throw new Error(result.data);
    }
    console.log(`Sent Slack notification for ${prCount} PRs.`);
};
