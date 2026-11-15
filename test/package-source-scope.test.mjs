import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { pushCommit } from '@red-cup-engineering/pushing-current-branch-service';

function repositories(t) {
  const scratch = mkdtempSync(join(tmpdir(), 'package-source-push-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const source = join(scratch, 'source'), remote = join(scratch, 'remote.git');
  mkdirSync(source);
  const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
  git(scratch, 'init', '-q', '--bare', remote);
  git(source, 'init', '-qb', 'main');
  git(source, 'config', 'user.name', 'Local release fixture');
  git(source, 'config', 'user.email', 'local@example.invalid');
  const write = (path, value) => writeFileSync(join(source, path), value);
  const commit = message => { git(source, 'add', '-A'); git(source, 'commit', '-qm', message); return git(source, 'rev-parse', 'HEAD'); };
  const head = () => git(remote, 'rev-parse', 'refs/heads/main');
  const push = commit => pushCommit({ cwd: source, remoteUrl: remote, branch: 'main', commit });
  return { source, remote, git, write, commit, head, push, scratch };
}

test('the exact push refuses an unseeded package-manifest index and accepts its repaired source', async t => {
  const r = repositories(t);
  r.write('package.json', '{"name":"example","version":"0.1.0","exports":"./index.mjs"}\n');
  r.write('index.mjs', 'export const ready = true;\n');
  const base = r.commit('Initial executable package');
  await r.push(base);
  const env = { ...process.env, GIT_INDEX_FILE: join(r.scratch, 'unseeded.index') };
  const isolated = (...args) => execFileSync('git', ['-C', r.source, ...args], { env, encoding:'utf8' }).trim();
  isolated('read-tree', '--empty');
  r.write('package.json', '{"name":"example","version":"0.1.1","exports":"./index.mjs"}\n');
  isolated('add', '--', 'package.json');
  const malformed = isolated('commit-tree', isolated('write-tree'), '-p', base, '-m', 'Update the manifest');
  await assert.rejects(r.push(malformed), error =>
    error.code === 'GIT_SOURCE_SCOPE_REFUSED' && error.stage === 'source-admission');
  assert.equal(r.head(), base);

  // A shallow clone hides the traversable parent, but the recorded commit
  // still has one. Missing history is not proof of a new metadata package.
  r.git(r.source, 'update-ref', 'refs/heads/manifest-proposal', malformed);
  const shallow = join(r.scratch, 'shallow');
  r.git(r.scratch, 'clone', '--quiet', '--depth=1', '--branch', 'manifest-proposal',
    pathToFileURL(r.source).href, shallow);
  assert.equal(r.git(shallow, 'rev-list', '--parents', '-n', '1', malformed), malformed);
  const before = r.git(shallow, 'ls-files', '--stage');
  await assert.rejects(pushCommit({cwd:shallow,remoteUrl:r.remote,branch:'main',commit:malformed}),
    error => error.code === 'GIT_SOURCE_UNAVAILABLE' && error.stage === 'source-admission');
  assert.equal(r.head(), base);
  assert.equal(r.git(shallow, 'rev-parse', 'HEAD'), malformed);
  assert.equal(r.git(shallow, 'ls-files', '--stage'), before);

  // Supply the exact repaired tree, retaining the witnessed incident in history.
  r.git(r.source, 'add', '--', 'package.json');
  const repaired = r.git(r.source, 'commit-tree', r.git(r.source, 'write-tree'), '-p', malformed, '-m', 'Recover source');
  assert.equal((await r.push(repaired)).commit, repaired);
  assert.equal(r.head(), repaired);
});

test('an initial metadata-only package is not a destructive transition', async t => {
  const r = repositories(t);
  r.write('package.json', '{"name":"descriptor","version":"0.1.0","exports":"./package.json"}\n');
  const first = r.commit('Create package descriptor');
  assert.equal((await r.push(first)).commit, first);
  assert.equal(r.head(), first);
});
