import { workersProject } from './vitest.workers';

export default await workersProject('integration', [
  'tests/integration/**/*.test.ts',
  'tests/contract/run-workers.test.ts',
  'tests/unit/markdown.test.ts',
]);
