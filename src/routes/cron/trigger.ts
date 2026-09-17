import express from 'express';
import { runPRCheck } from '../../cron/dailyPr.js';
import { toHttpErrorLike } from '../../types/http.js';

const router = express.Router();

// 수동으로 PR 체크를 즉시 실행하는 엔드포인트
router.get('/', async (req, res) => {
    console.log('Manual PR check triggered via API');

    try {
        const result = await runPRCheck();
        res.json({
            success: true,
            message: 'PR check executed successfully',
            data: result,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        const parsedError = toHttpErrorLike(error);
        console.error('Error executing manual PR check:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to execute PR check',
            error: parsedError.message,
            timestamp: new Date().toISOString()
        });
    }
});

export default router;
