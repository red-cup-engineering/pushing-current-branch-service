#!/usr/bin/env node
// push-current-branch — publishes the active branch's commits to a
// remote so the remote's matching branch advances to the local tip.
//
// Module: default-exports async ({ cwd?, remote?, branch?, setUpstream?, gitBin? })
//         → { pushed: true, remote, branch, root }
// CLI:    push-current-branch
//           [--cwd <dir>] [--remote <name>] [--branch <name>] [--set-upstream] [--git-bin <path>]
//
// The Git binary defaults to the system Git and may be overridden explicitly
// for tests.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultGit = '/usr/bin/git';

/** Publish one immutable source selection only after its complete declared
 * submodule graph can be read from the declared suppliers. Local tracking refs
 * and another remote containing the same object are not publication evidence.
 * Reads use disposable Git repositories, never the caller's index or modules.
 * Unreadable, missing, malformed or over-budget source holds the entire push.
 */
export async function pushCommit({ cwd, remoteUrl, commit, branch,
  gitBin = defaultGit, timeoutMs = 60_000, maxRepositories = 256 } = {}) {
  if (!/^[0-9a-f]{40}$/u.test(commit ?? '') || typeof remoteUrl !== 'string' || !remoteUrl ||
      typeof branch !== 'string' || !branch ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 ||
      !Number.isSafeInteger(maxRepositories) || maxRepositories < 1)
    throw new TypeError('exact commit, destination and finite positive source bounds required');
  const deadline = Date.now() + timeoutMs;
  let stage = 'source-admission';
  const git = (dir, args) => {
    const remaining = deadline - Date.now();
    if (remaining < 1) throw new Error('declared source admission budget exhausted');
    const r = spawnSync(gitBin, ['-c', 'protocol.allow=never', '-c', 'protocol.file.allow=always',
      '-c', 'protocol.https.allow=always', '-c', 'protocol.ssh.allow=always', '-C', dir, ...args], { encoding: 'utf8',
      timeout: remaining, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' } });
    if (r.error || r.status !== 0) {
      const error = new Error(stage === 'source-admission' ? 'declared source or Git transport unavailable' : 'Git push was not acknowledged');
      error.stage = stage;
      // Only Git's selected-ref porcelain record can prove a rejected write.
      // Remote diagnostics are arbitrary text; transport loss is always uncertain.
      const records = (r.stdout ?? '').split('\n').filter(line => /^[ !*+=-]\t/u.test(line));
      const rejected = !r.error && !r.signal && r.status === 1 && records.length === 1 &&
        ['non-fast-forward', 'fetch first'].some(reason =>
          records[0] === `!\t${commit}:refs/heads/${branch}\t[rejected] (${reason})`);
      error.code = stage === 'source-admission' ? 'GIT_SOURCE_UNAVAILABLE'
        : rejected ? 'GIT_PUSH_REJECTED' : 'GIT_PUSH_UNCERTAIN';
      throw error;
    }
    return r.stdout;
  };
  const root = git(cwd, ['rev-parse', '--show-toplevel']).trim();
  git(root, ['check-ref-format', `refs/heads/${branch}`]);
  if (git(root, ['rev-parse', '--verify', `${commit}^{commit}`]).trim() !== commit)
    throw new Error('outgoing commit identity changed');
  const scratch = mkdtempSync(join(tmpdir(), 'declared-git-source-'));
  const seen = new Set();
  let count = 0;
  try {
    const receive = (source, sha, local = false) => {
      const identity = JSON.stringify([source, sha]);
      if (seen.has(identity)) return;
      if (++count > maxRepositories) throw new Error('declared source repository bound exhausted');
      seen.add(identity);
      const dir = join(scratch, String(count));
      git(scratch, ['init', '-q', dir]);
      // The root is the proposed local commit; every descendant must actually
      // be fetched from its own committed supplier, including old archive pins.
      git(dir, ['fetch', '--quiet', '--no-tags', '--no-recurse-submodules', '--depth=1', '--', local ? root : source, sha]);
      if (git(dir, ['rev-parse', 'FETCH_HEAD^{commit}']).trim() !== sha)
        throw new Error('declared supplier returned another commit');
      git(dir, ['remote', 'add', 'origin', source]);
      git(dir, ['update-ref', 'HEAD', sha]);
      git(dir, ['read-tree', sha]);
      const rows = git(dir, ['ls-tree', '-r', '-z', sha]).split('\0').filter(Boolean);
      const links = rows.filter(row => row.startsWith('160000 commit ')).map(row => {
        const tab = row.indexOf('\t'); return { sha: row.slice(14, tab), path: row.slice(tab + 1) };
      });
      if (!rows.some(row => row.endsWith('\t.gitmodules'))) {
        if (links.length) throw new Error('committed submodule declarations are missing');
        return;
      }
      const modules = git(dir, ['show', `${sha}:.gitmodules`]);
      writeFileSync(join(dir, '.gitmodules'), modules);
      const declared = git(dir, ['config', '--null', '--blob', `${sha}:.gitmodules`, '--list'])
        .split('\0').filter(row => /^submodule\..*\.path\n/u.test(row)).map(row => {
          const at = row.indexOf('\n'); return { key: row.slice(0, at).slice(0, -5), path: row.slice(at + 1) };
        });
      if (declared.length !== links.length || new Set(declared.map(d => d.path)).size !== links.length ||
          links.some(link => !declared.some(d => d.path === link.path)))
        throw new Error('committed submodule declarations do not match selected Gitlinks');
      if (!links.length) return;
      // Native Git resolves relative URLs against the intended supplier origin.
      // No init/update is run in the user's checkout and no child code is run.
      git(dir, ['submodule', 'init']);
      for (const link of links) {
        const key = declared.find(d => d.path === link.path).key;
        const url = git(dir, ['config', '--get-all', `${key}.url`]).trim();
        if (!url || url.includes('\n')) throw new Error('declared child supplier is missing or ambiguous');
        receive(url, link.sha);
      }
    };
    receive(remoteUrl, commit, true);
    const args = ['push', '--porcelain', '--recurse-submodules=check'];
    args.push('--', remoteUrl, `${commit}:refs/heads/${branch}`);
    stage = 'push';
    git(root, args);
    return { pushed: true, remote: remoteUrl, branch, root, commit, verifiedRepositories: count };
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

function resolveGitBin(gitBin) {
  return gitBin || defaultGit;
}

function runGit(gitBin, cwd, args, { capture = true } = {}) {
  const result = spawnSync(resolveGitBin(gitBin), args, {
    cwd,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  if (result.error) throw result.error;
  return { code: result.status, stdout: (result.stdout ?? '').trim(), stderr: (result.stderr ?? '').trim() };
}

export default async function pushTheCurrentBranch({ cwd, remote = 'origin', branch, setUpstream = false, gitBin } = {}) {
  const start = cwd
    ? (isAbsolute(cwd) ? cwd : resolve(process.cwd(), cwd))
    : process.cwd();

  const top = runGit(gitBin, start, ['rev-parse', '--show-toplevel']);
  if (top.code !== 0) throw new Error(`not a git repository: ${start} (${top.stderr})`);
  const root = top.stdout;

  const head = runGit(gitBin, root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (head.code !== 0) throw new Error(`git rev-parse failed in ${root}: ${head.stderr}`);
  const localBranch = head.stdout;
  if (localBranch === 'HEAD') throw new Error(`HEAD is detached in ${root}; refusing to push without an explicit branch`);
  const remoteBranch = branch ?? localBranch;

  const destination = runGit(gitBin, root, ['remote', 'get-url', '--push', '--all', remote]);
  if (destination.code !== 0 || destination.stdout.split('\n').length !== 1)
    throw new Error('one effective push destination required');
  const source = runGit(gitBin, root, ['rev-parse', 'HEAD']);
  await pushCommit({ cwd: root, remoteUrl: destination.stdout, commit: source.stdout,
    branch: remoteBranch, gitBin: resolveGitBin(gitBin) });
  if (setUpstream) {
    // SHA refspecs deliberately do not tell Git which local branch to track.
    // Establish tracking only after the exact push succeeded and the original
    // branch/source/destination still agree; never silently retarget new work.
    if (runGit(gitBin, root, ['rev-parse', 'HEAD']).stdout !== source.stdout ||
        runGit(gitBin, root, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout !== localBranch ||
        runGit(gitBin, root, ['remote', 'get-url', '--push', '--all', remote]).stdout !== destination.stdout) {
      const error = new Error('push succeeded but upstream selection changed');
      error.pushed = true; throw error;
    }
    for (const args of [
      ['update-ref', `refs/remotes/${remote}/${remoteBranch}`, source.stdout],
      ['config', `branch.${localBranch}.remote`, remote],
      ['config', `branch.${localBranch}.merge`, `refs/heads/${remoteBranch}`],
    ]) {
      const result = runGit(gitBin, root, args);
      if (result.code !== 0) { const error = new Error('push succeeded but upstream tracking was not completed'); error.pushed = true; throw error; }
    }
  }
  return { pushed: true, remote, branch: remoteBranch, root };
}

if (resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1] ?? '')) {
  const args = process.argv.slice(2);
  let cwd = null, remote = 'origin', branch = null, setUpstream = false, gitBin = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--cwd' && i + 1 < args.length) cwd = args[++i];
    else if (args[i] === '--remote' && i + 1 < args.length) remote = args[++i];
    else if (args[i] === '--branch' && i + 1 < args.length) branch = args[++i];
    else if (args[i] === '--set-upstream') setUpstream = true;
    else if (args[i] === '--git-bin' && i + 1 < args.length) gitBin = args[++i];
  }
  try {
    const out = await pushTheCurrentBranch({ cwd, remote, branch, setUpstream, gitBin });
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  } catch (err) {
    process.stderr.write(`push-current-branch: ${err.message}\n`);
    process.exit(1);
  }
}

