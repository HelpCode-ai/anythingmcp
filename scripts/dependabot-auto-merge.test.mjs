import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { Script } from 'node:vm';

// Exercise the actual inline action without checking out or executing PR code.
const workflow = readFileSync(new URL('../.github/workflows/dependabot-auto-merge.yml', import.meta.url), 'utf8');
const lines = workflow.split(/\r?\n/);
const step = lines.findIndex((line) => line.trim() === '- name: Label as needs-review');
assert.ok(step >= 0, 'review notice step exists');
const start = lines.findIndex((line, index) => index > step && line.trim() === 'script: |');
assert.ok(start > step, 'review notice script exists');
const bodyLines = [];
for (const line of lines.slice(start + 1)) {
  if (line.trim() && !line.startsWith('            ')) break;
  bodyLines.push(line.slice(12));
}
const action = new Script(`(async () => {\n${bodyLines.join('\n')}\n})()`);
const reason = 'runtime dependency (imapflow)';
const notice = (value = reason) => `Skipping auto-merge: ${value}. A human should review this bump.`;
const botComment = (body) => ({ user: { login: 'github-actions[bot]' }, body });

function fixture(options = {}) {
  const comments = [...(options.comments ?? [])];
  const posts = [], labels = [], queries = [], warnings = [];
  const listComments = () => {};
  const github = {
    rest: { issues: {
      listComments,
      async addLabels(params) {
        if (options.labelError) throw options.labelError;
        labels.push(structuredClone(params));
      },
      async createComment(params) {
        if (options.postError) throw options.postError;
        posts.push(structuredClone(params));
        comments.push(botComment(params.body));
      },
    } },
    async paginate(method, params) {
      assert.equal(method, listComments);
      queries.push(structuredClone(params));
      if (options.listError) throw options.listError;
      return comments;
    },
  };
  const run = (value = reason) => action.runInNewContext({
    github,
    context: { repo: { owner: 'example', repo: 'project' }, payload: { pull_request: { number: 1897 } } },
    process: { env: { REVIEW_REASON: value } },
    core: { info() {}, warning(message) { warnings.push(message); } },
  });
  return { run, posts, labels, queries, warnings };
}

test('repeated synchronize events post once and still apply the review label', async () => {
  const state = fixture();
  await state.run();
  await state.run();
  assert.deepEqual(state.posts, [{ owner: 'example', repo: 'project', issue_number: 1897, body: notice() }]);
  assert.equal(state.labels.length, 2);
  assert.deepEqual(state.labels[0].labels, ['needs-review']);
  assert.deepEqual(state.queries[0], { owner: 'example', repo: 'project', issue_number: 1897, per_page: 100 });
});

test('an existing unmarked notice from the old workflow suppresses another copy', async () => {
  const state = fixture({ comments: [botComment(notice())] });
  await state.run();
  assert.equal(state.posts.length, 0);
});

test('a matching human comment does not suppress the bot notice', async () => {
  const state = fixture({ comments: [{ user: { login: 'contributor' }, body: notice() }, { body: notice() }] });
  await state.run();
  assert.equal(state.posts.length, 1);
});

test('a changed review reason gets one new notice without editing old comments', async () => {
  const state = fixture({ comments: [botComment(notice())] });
  const changed = 'not-patch-or-minor (version-update:semver-major)';
  await state.run(changed);
  await state.run(changed);
  assert.deepEqual(state.posts.map((post) => post.body), [notice(changed)]);
});

test('checks paginated comments even when the matching notice is beyond page one', async () => {
  const comments = Array.from({ length: 101 }, () => botComment('Other workflow message'));
  comments.push(botComment(notice()));
  const state = fixture({ comments });
  await state.run();
  assert.equal(state.posts.length, 0);
  assert.equal(state.queries.length, 1);
});

test('does not risk a duplicate when reading comments fails', async () => {
  const state = fixture({ listError: new Error('Comment API unavailable') });
  await assert.rejects(state.run(), /Comment API unavailable/);
  assert.equal(state.posts.length, 0);
});

test('still posts the notice if adding the label fails', async () => {
  const state = fixture({ labelError: new Error('Label API unavailable') });
  await state.run();
  assert.equal(state.posts.length, 1);
  assert.equal(state.warnings.length, 1);
});

test('reports a failed comment write rather than treating it as success', async () => {
  const state = fixture({ postError: new Error('Comment write failed') });
  await assert.rejects(state.run(), /Comment write failed/);
  assert.equal(state.posts.length, 0);
});

test('requires a reason and treats its contents as data', async () => {
  const state = fixture();
  await assert.rejects(state.run(''), /Missing auto-merge review reason/);
  const value = 'runtime dependency (`text` ${throw new Error("not code")})';
  await state.run(value);
  assert.equal(state.posts[0].body, notice(value));
});
