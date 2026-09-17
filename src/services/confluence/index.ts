import axios from 'axios';
import {
    ATLASSIAN_SITE,
    ATLASSIAN_EMAIL,
    ATLASSIAN_API_TOKEN,
    CONFLUENCE_SPACE_KEY,
    MAX_W,
    slackWebhookUrlQa
} from '../../config/env.js';
import { slackHooksCall } from '../../lib/slackWebhook.js';
import { toHttpErrorLike } from '../../types/http.js';

type BlogPostArgs = {
    title: string;
};

type ConfluenceContent = {
    id?: string;
};

type WeeklyBlogResult = {
    success: boolean;
    message: string;
    id?: string;
    title: string;
};


/**
 * 회계연도 라벨처럼 두 자리 숫자가 필요한 값을 0-padding한다.
 */
function pad2(n: number): string {
    return String(n).padStart(2, '0');
}

/**
 * FY 규칙:
 * - FY는 3월 시작
 * - FY2627 = 2026-03 ~ 2027-02
 */
function getFiscalYearLabel(dateKst: Date): string {
    const y = dateKst.getFullYear();
    const m = dateKst.getMonth() + 1;
    const fyStartYear = m >= 3 ? y : y - 1;
    const a = fyStartYear % 100;
    const b = (fyStartYear + 1) % 100;
    return `FY${pad2(a)}${pad2(b)}`;
}

/**
 * W 규칙(기본):
 * - 3월 1일이 포함된 주를 1W로 본다.
 * - 주 시작은 월요일(ISO 주차 유사)로 계산
 * - 필요 시 MAX_W로 상한 캡
 */
function startOfWeekMonday(d: Date): Date {
    const x = new Date(d);
    const day = x.getDay();
    const diff = day === 0 ? -6 : 1 - day;
    x.setDate(x.getDate() + diff);
    x.setHours(0, 0, 0, 0);
    return x;
}

/**
 * FY 시작 주차를 기준으로 현재 날짜의 주차 라벨(Wn)을 계산한다.
 * 운영상 MAX_W가 설정되어 있으면 문서 제목의 주차가 그 값을 넘지 않도록 제한한다.
 */
function getWeekLabel(dateKst: Date): string {
    const y = dateKst.getFullYear();
    const m = dateKst.getMonth() + 1;
    const fyStartYear = m >= 3 ? y : y - 1;

    const fyStart = new Date(fyStartYear, 2, 1, 0, 0, 0, 0);
    const w0 = startOfWeekMonday(fyStart);
    const wN = startOfWeekMonday(dateKst);

    const diffDays = Math.floor((wN.getTime() - w0.getTime()) / (1000 * 60 * 60 * 24));
    let week = Math.floor(diffDays / 7) + 1;

    if (MAX_W && Number.isFinite(MAX_W) && MAX_W > 0) {
        week = Math.min(week, MAX_W);
    }
    return `W${week}`;
}

/**
 * 주간 블로그 글 제목을 `FY2627 W5 이슈 및 현안` 형식으로 만든다.
 */
function getTitle(dateKst: Date): string {
    const fy = getFiscalYearLabel(dateKst);
    const w = getWeekLabel(dateKst);
    return `${fy} ${w} 이슈 및 현안`;
}

/**
 * Confluence REST API Basic 인증 헤더를 만든다.
 */
function basicAuthHeader(email: string | undefined, token: string | undefined): string {
    const b64 = Buffer.from(`${email}:${token}`).toString('base64');
    return `Basic ${b64}`;
}

/**
 * 같은 제목의 Confluence blog post가 이미 있는지 조회한다.
 * 중복 생성 방지를 위해 create 전에 항상 호출된다.
 */
async function checkBlogPostExists({ title }: BlogPostArgs): Promise<ConfluenceContent | null> {
    const baseUrl = (ATLASSIAN_SITE as string).replace(/\/$/, '');
    const url = `${baseUrl}/wiki/rest/api/content?spaceKey=${CONFLUENCE_SPACE_KEY}&title=${encodeURIComponent(title)}&type=blogpost`;

    try {
        const res = await axios.get(url, {
            headers: {
                Authorization: basicAuthHeader(ATLASSIAN_EMAIL, ATLASSIAN_API_TOKEN),
                Accept: 'application/json',
            },
        });

        return res.data.results && res.data.results.length > 0 ? res.data.results[0] : null;
    } catch (error) {
        const parsedError = toHttpErrorLike(error);
        throw new Error(
            `Confluence API failed: ${parsedError.response?.status} ${parsedError.response?.statusText}\n${parsedError.response?.data ? JSON.stringify(parsedError.response.data) : parsedError.message
            }`,
        );
    }
}

/**
 * 빈 storage body를 가진 Confluence blog post를 생성한다.
 * 실제 본문 작성은 이 서비스 범위 밖이며, 여기서는 제목/공간 생성만 담당한다.
 */
async function createBlogPost({ title }: BlogPostArgs): Promise<ConfluenceContent> {
    const url = `${(ATLASSIAN_SITE as string).replace(/\/$/, '')}/wiki/rest/api/content`;

    const payload = {
        type: 'blogpost',
        title,
        space: { key: CONFLUENCE_SPACE_KEY },
        body: {
            storage: {
                value: '<p></p>',
                representation: 'storage',
            },
        },
    };

    try {
        const res = await axios.post(url, payload, {
            headers: {
                Authorization: basicAuthHeader(ATLASSIAN_EMAIL, ATLASSIAN_API_TOKEN),
                'Content-Type': 'application/json',
                Accept: 'application/json',
            },
        });

        return res.data;
    } catch (error) {
        const parsedError = toHttpErrorLike(error);
        throw new Error(
            `Confluence API failed: ${parsedError.response?.status} ${parsedError.response?.statusText}\n${parsedError.response?.data ? JSON.stringify(parsedError.response.data) : parsedError.message
            }`,
        );
    }
}

/**
 * 현재 KST 기준 주간 블로그 글을 생성한다.
 * 이미 같은 제목이 있으면 새 글을 만들지 않고 existing 결과를 반환한다.
 */
export async function createWeeklyBlogPost(): Promise<WeeklyBlogResult> {
    console.log('Creating weekly Confluence blog post...');
    try {
        // UTC → KST 변환 (Docker가 UTC여도 안전하게 한국 시간 기준으로 계산)
        const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
        const title = getTitle(now);

        const existing = await checkBlogPostExists({ title });
        if (existing) {
            console.log('Blog post already exists:');
            console.log('ID:', existing.id);
            console.log('Title:', title);
            return { success: true, message: 'Blog post already exists', id: existing.id, title };
        }

        const created = await createBlogPost({ title });
        console.log('Created:', created?.id ?? created);
        console.log('Title:', title);

        await slackHooksCall(slackWebhookUrlQa, {
            text: `✨ 주간보고 블로그 글이 생성되었습니다. (제목: ${title})`
        });

        return { success: true, message: 'Blog post created successfully', id: created?.id, title };
    } catch (error) {
        const parsedError = toHttpErrorLike(error);
        console.error('Error creating weekly blog post:', error);

        await slackHooksCall(slackWebhookUrlQa, {
            text: `🚨 서버문제로 주간보고 글생성이 실패했습니다.\n에러 내용: ${parsedError.message}`
        });

        throw error;
    }
}
