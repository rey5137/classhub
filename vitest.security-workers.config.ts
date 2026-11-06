import { workersProject } from './vitest.workers';

// `test:security` checks that need the Workers runtime, such as a direct request to the
// ChatRoom Durable Object (AC-CHAT-04).
export default await workersProject('security-workers', ['tests/security/**/*.workers.test.ts']);
