import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

for (const server of [1, 2]) {
  test(`server ${server} production deployment is main-only and recoverable`, () => {
    const workflow = readFileSync(new URL(`../.github/workflows/deploy-prod${server}.yml`, import.meta.url), 'utf8');
    assert.match(workflow, /push:\s*\n\s*branches: \[main\]/);
    assert.match(workflow, /github\.ref == 'refs\/heads\/main'/);
    assert.doesNotMatch(workflow, /refs\/heads\/dev/);
    assert.match(workflow, new RegExp(`group: infra-production-server${server}`));
    assert.match(workflow, /cancel-in-progress: false/);
    assert.match(workflow, new RegExp(`cp docker-compose-prod${server}\\.yml \\.previous-compose-prod${server}\\.yml`));
    assert.match(workflow, new RegExp(`cp \\.previous-compose-prod${server}\\.yml docker-compose-prod${server}\\.yml`));
    assert.match(workflow, /up -d --wait/);
    assert.doesNotMatch(workflow, /down\s+-v|volume\s+rm|image prune/);
  });
}
