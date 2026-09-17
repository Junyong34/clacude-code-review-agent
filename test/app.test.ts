import test from 'node:test';
import assert from 'node:assert/strict';

import app from '../src/app.js';

type RouteLayer = {
    route?: {
        path?: string;
        methods?: Record<string, boolean>;
    };
};

test('app import registers the legacy health-check route without server startup', () => {
    const stack = (app as unknown as { _router: { stack: RouteLayer[] } })._router.stack;

    assert.equal(
        stack.some((layer) => layer.route?.path === '/health-check' && layer.route.methods?.get === true),
        true,
    );
});
