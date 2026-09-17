import express from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import comment from './routes/pr/comment.js';
import open from './routes/pr/open.js';
import approved from './routes/pr/approved.js';
import close from './routes/pr/close.js';
import merged from './routes/pr/merged.js';
import reviewers from './routes/pr/reviewers.js';
import modified from './routes/pr/modified.js';
import { startCron, stopCron, getStatus } from './cron/dailyPr.js';
import { startWeeklyBlogCron, stopWeeklyBlogCron, getWeeklyBlogStatus, runWeeklyBlogPost } from './cron/weeklyBlog.js';
import trigger from './routes/cron/trigger.js';
import { toHttpErrorLike } from './types/http.js';

const app = express();

app.use(cors());
app.use(bodyParser.json());

app.use('/pr/comment', comment);
app.use('/pr/open', open);
app.use('/pr/approved', approved);
app.use('/pr/merged', merged);
app.use('/pr/close', close);
app.use('/pr/reviewers', reviewers);
app.use('/pr/modified', modified);

// Cron Job Control and Trigger Endpoints
app.use('/deploy/check', trigger);
app.get('/cron/start', (req, res) => {
    const success = startCron();
    res.json({ message: success ? 'Cron job started' : 'Cron job already running', status: getStatus() });
});

app.get('/cron/stop', (req, res) => {
    const success = stopCron();
    res.json({ message: success ? 'Cron job stopped' : 'Cron job not running', status: getStatus() });
});

app.get('/cron/status', (req, res) => {
    res.json(getStatus());
});

// Weekly Blog Cron Job Control Endpoints
app.get('/confluence/start', (req, res) => {
    const success = startWeeklyBlogCron();
    res.json({ message: success ? 'Weekly blog cron job started' : 'Weekly blog cron job already running', status: getWeeklyBlogStatus() });
});

app.get('/confluence/stop', (req, res) => {
    const success = stopWeeklyBlogCron();
    res.json({ message: success ? 'Weekly blog cron job stopped' : 'Weekly blog cron job not running', status: getWeeklyBlogStatus() });
});

app.get('/confluence/status', (req, res) => {
    res.json(getWeeklyBlogStatus());
});

app.get('/confluence/create', async (req, res) => {
    try {
        const result = await runWeeklyBlogPost();
        res.json(result);
    } catch (error) {
        const parsedError = toHttpErrorLike(error);
        res.status(500).json({ success: false, message: 'Failed to create blog post', error: parsedError.message });
    }
});

// 헬스체크 엔드포인트
app.get('/health-check', (req, res) => {
    // 웹훅 데이터를 받아와서 처리 로직을 작성합니다.
    console.log('살아있니');

    // 웹훅 처리 후 응답
    res.status(200).send('살아있다');
});

export default app;
