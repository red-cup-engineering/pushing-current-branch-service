import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import pushCurrentBranch, { pushCommit } from "../scripts/push-current-branch.mjs";

const gitBin = "/usr/bin/git";

test("pushCurrentBranch publishes HEAD to the matching remote branch", async () => {
  const root = await mkdtemp(join(tmpdir(), "push-current-branch-"));
  const repository = join(root, "repository");
  const remote = join(root, "remote.git");
  try {
    git(root, ["init", "-q", "--bare", remote]);
    git(root, ["init", "-q", "-b", "main", repository]);
    git(repository, ["config", "user.name", "Test"]);
    git(repository, ["config", "user.email", "test@example.invalid"]);
    await writeFile(join(repository, "file.txt"), "one\n");
    git(repository, ["add", "file.txt"]);
    git(repository, ["commit", "-qm", "Initial commit"]);
    git(repository, ["remote", "add", "origin", remote]);

    const result = await pushCurrentBranch({ cwd: repository, gitBin });
    assert.equal(result.pushed, true);
    assert.equal(result.branch, "main");
    assert.equal(git(remote, ["rev-parse", "refs/heads/main"]), git(repository, ["rev-parse", "HEAD"]));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function git(cwd, args) {
  return execFileSync(gitBin, args, { cwd, encoding: "utf8" }).trim();
}

async function estate(t) {
  const root = await mkdtemp(join(tmpdir(), 'declared-source-fixture-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  async function repository(name) {
    const path = join(root, name), remote = join(root, name + '.git');
    git(root, ['init', '-q', '--bare', remote]);
    git(root, ['init', '-q', '-b', 'main', path]);
    git(path, ['config', 'user.name', 'fixture']);
    git(path, ['config', 'user.email', 'fixture@example.invalid']);
    await writeFile(join(path, 'source.txt'), name + '\n');
    git(path, ['add', '.']); git(path, ['commit', '-qm', 'initial']);
    git(path, ['remote', 'add', 'origin', remote]);
    git(path, ['push', '-q', 'origin', 'main']);
    return { path, remote, first: git(path, ['rev-parse', 'HEAD']) };
  }
  const parent = await repository('parent'), child = await repository('child');
  async function mount(owner, selection, url = selection.remote) {
    await mkdir(join(owner.path, 'lib/component'), { recursive: true });
    await writeFile(join(owner.path, '.gitmodules'), `[submodule "component"]\npath = lib/component\nurl = ${url}\n`);
    git(owner.path, ['add', '.gitmodules']);
    git(owner.path, ['update-index', '--add', '--cacheinfo', `160000,${git(selection.path, ['rev-parse', 'HEAD'])},lib/component`]);
    git(owner.path, ['commit', '-qm', 'select component']);
  }
  async function change(owner) {
    await writeFile(join(owner.path, 'source.txt'), 'changed\n');
    git(owner.path, ['commit', '-qam', 'new source']);
  }
  const push = () => pushCommit({ cwd: parent.path, remoteUrl: parent.remote,
    branch: 'main', commit: git(parent.path, ['rev-parse', 'HEAD']) });
  const unchanged = () => assert.equal(git(parent.remote, ['rev-parse', 'refs/heads/main']), parent.first);
  return { root, parent, child, repository, mount, change, push, unchanged };
}

test('published declared child is received by an independent recursive clone', async t => {
  const e = await estate(t); await e.mount(e.parent, e.child);
  const out = await e.push(); assert.equal(out.verifiedRepositories, 2);
  const clone = join(e.root, 'receiver');
  git(e.root, ['-c', 'protocol.file.allow=always', 'clone', '-q', '--branch', 'main', '--recurse-submodules', e.parent.remote, clone]);
  assert.equal(await readFile(join(clone, 'lib/component/source.txt'), 'utf8'), 'child\n');
});

test('published historical child is accepted without advancing the archive pin', async t => {
  const e = await estate(t); await e.mount(e.parent, e.child);
  await e.change(e.child); git(e.child.path, ['push', '-q', 'origin', 'main']);
  await e.push();
  assert.equal(git(e.parent.remote, ['rev-parse', 'main:lib/component']), e.child.first);
});

test('local-only child is held before parent publication', async t => {
  const e = await estate(t); await e.change(e.child); await e.mount(e.parent, e.child);
  await assert.rejects(e.push(), /unavailable/); e.unchanged();
});

test('same commit published only to a different remote does not qualify declared supplier', async t => {
  const e = await estate(t); await e.change(e.child);
  const wrong = join(e.root, 'wrong.git'); git(e.root, ['init', '-q', '--bare', wrong]);
  git(e.child.path, ['remote', 'add', 'other', wrong]); git(e.child.path, ['push', '-q', 'other', 'main']);
  await e.mount(e.parent, e.child);
  await assert.rejects(e.push(), /unavailable/); e.unchanged();
});

test('committed supplier URL, not dirty working declaration, governs admission', async t => {
  const e = await estate(t); const wrong = await e.repository('unrelated');
  await e.mount(e.parent, e.child, wrong.remote);
  await writeFile(join(e.parent.path, '.gitmodules'), `[submodule "component"]\npath = lib/component\nurl = ${e.child.remote}\n`);
  await assert.rejects(e.push(), /unavailable/); e.unchanged();
});

test('unpublished nested descendant holds an otherwise published child', async t => {
  const e = await estate(t); const grandchild = await e.repository('grandchild');
  await e.change(grandchild); await e.mount(e.child, grandchild);
  git(e.child.path, ['push', '-q', 'origin', 'main']); await e.mount(e.parent, e.child);
  await assert.rejects(e.push(), /unavailable/); e.unchanged();
});

test('missing or mismatched declarations hold parent without source changes', async t => {
  const e = await estate(t); await e.mount(e.parent, e.child);
  await writeFile(join(e.parent.path, '.gitmodules'), '[submodule "component"]\npath = other\nurl = ignored\n');
  git(e.parent.path, ['commit', '-qam', 'mismatched declaration']);
  const head = git(e.parent.path, ['rev-parse', 'HEAD']);
  await assert.rejects(e.push(), /do not match/); e.unchanged();
  assert.equal(git(e.parent.path, ['rev-parse', 'HEAD']), head);
  git(e.parent.path, ['rm', '-q', '.gitmodules']); git(e.parent.path, ['commit', '-qm', 'missing declaration']);
  await assert.rejects(e.push(), /declarations are missing/); e.unchanged();
});

test('finite repository budget holds publication and relative declared URL uses destination', async t => {
  const e = await estate(t); await e.mount(e.parent, e.child, '../child.git');
  await assert.rejects(pushCommit({ cwd: e.parent.path, remoteUrl: e.parent.remote,
    branch: 'main', commit: git(e.parent.path, ['rev-parse', 'HEAD']), maxRepositories: 1 }), /bound exhausted/);
  e.unchanged(); await e.push();
});

test('current-branch wrapper retains set-upstream semantics with a differently named destination branch', async t => {
  const e = await estate(t);
  await pushCurrentBranch({ cwd: e.parent.path, branch: 'received', setUpstream: true });
  assert.equal(git(e.parent.path, ['rev-parse', '--abbrev-ref', '@{upstream}']), 'origin/received');
  assert.equal(git(e.parent.path, ['rev-parse', '@{upstream}']), e.parent.first);
  assert.equal(git(e.parent.path, ['config', 'branch.main.remote']), 'origin');
});

test('missing branch and orphan declaration refuse before parent publication', async t => {
  const e = await estate(t);
  await assert.rejects(pushCommit({ cwd: e.parent.path, remoteUrl: e.parent.remote, commit: e.parent.first }), /exact commit/);
  await writeFile(join(e.parent.path, '.gitmodules'), `[submodule "orphan"]\npath = missing\nurl = ${e.child.remote}\n`);
  git(e.parent.path, ['add', '.gitmodules']); git(e.parent.path, ['commit', '-qm', 'orphan']);
  await assert.rejects(e.push(), /do not match/); e.unchanged();
});

test('source transport failure and explicit parent rejection have distinct stages', async t => {
  const e = await estate(t); await e.change(e.child); await e.mount(e.parent, e.child);
  await assert.rejects(e.push(), error => error.stage === 'source-admission' && error.code === 'GIT_SOURCE_UNAVAILABLE');
  e.unchanged();
  git(e.child.path, ['push', '-q', 'origin', 'main']);
  const peer = join(e.root, 'peer'); git(e.root, ['clone', '-q', '--branch', 'main', e.parent.remote, peer]);
  git(peer, ['config', 'user.name', 'fixture']); git(peer, ['config', 'user.email', 'fixture@example.invalid']);
  await writeFile(join(peer, 'other.txt'), 'concurrent\n'); git(peer, ['add', '.']); git(peer, ['commit', '-qm', 'concurrent']);
  git(peer, ['push', '-q', 'origin', 'main']);
  const received = git(e.parent.remote, ['rev-parse', 'main']);
  await assert.rejects(e.push(), error => error.stage === 'push' && error.code === 'GIT_PUSH_REJECTED');
  assert.equal(git(e.parent.remote, ['rev-parse', 'main']), received);
});

