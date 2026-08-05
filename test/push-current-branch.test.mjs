import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import pushCurrentBranch from "../scripts/push-current-branch.mjs";

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
