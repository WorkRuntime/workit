/**
 * Tests for the published-article link gate.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { findBrokenArticleLinks } from "./check-article-links.mjs";

test("reports missing relative article targets with their source line", async () => {
  const repositoryRoot = await createFixture();
  try {
    await writeFile(join(repositoryRoot, "articles", "post.md"), [
      "[valid](../evidence/proof.json)",
      "[missing](../evidence/missing.json)",
    ].join("\n"));

    assert.deepEqual(await findBrokenArticleLinks({ repositoryRoot }), [{
      article: "articles/post.md",
      line: 2,
      target: "../evidence/missing.json",
    }]);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

test("ignores anchors and external destinations", async () => {
  const repositoryRoot = await createFixture();
  try {
    await writeFile(join(repositoryRoot, "articles", "post.md"), [
      "[section](#section)",
      "[web](https://example.com/proof)",
      "[email](mailto:maintainer@example.com)",
    ].join("\n"));

    assert.deepEqual(await findBrokenArticleLinks({ repositoryRoot }), []);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
});

async function createFixture() {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "workit-article-links-"));
  await mkdir(join(repositoryRoot, "articles"));
  await mkdir(join(repositoryRoot, "evidence"));
  await writeFile(join(repositoryRoot, "evidence", "proof.json"), "{}\n");
  return repositoryRoot;
}
