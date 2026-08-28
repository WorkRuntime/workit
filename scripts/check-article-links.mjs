/**
 * Verifies that local links in published article sources resolve inside the repository.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ARTICLES_DIRECTORY = "articles";
const MARKDOWN_EXTENSION = ".md";
const MARKDOWN_LINK_PATTERN = /!?\[[^\]]*\]\(([^)]+)\)/g;
const EXTERNAL_SCHEMES = /^(?:https?:|mailto:|tel:|data:)/i;

export async function findBrokenArticleLinks({ repositoryRoot }) {
  const articlesRoot = resolve(repositoryRoot, ARTICLES_DIRECTORY);
  const entries = await readdir(articlesRoot, { withFileTypes: true });
  const articleFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(MARKDOWN_EXTENSION))
    .map((entry) => resolve(articlesRoot, entry.name))
    .sort();
  const failures = [];

  for (const articleFile of articleFiles) {
    const source = await readFile(articleFile, "utf8");
    for (const link of extractLocalLinks(source)) {
      const target = resolve(dirname(articleFile), link.target);
      if (!(await exists(target))) {
        failures.push({
          article: relative(repositoryRoot, articleFile).replaceAll("\\", "/"),
          line: lineAt(source, link.offset),
          target: link.target,
        });
      }
    }
  }

  return failures;
}

function extractLocalLinks(source) {
  return [...source.matchAll(MARKDOWN_LINK_PATTERN)].flatMap((match) => {
    const destination = normalizeDestination(match[1]);
    return destination === undefined
      ? []
      : [{ target: destination, offset: match.index ?? 0 }];
  });
}

function normalizeDestination(rawDestination) {
  const withoutTitle = rawDestination.trim().replace(/\s+["'][^"']*["']$/, "");
  const unwrapped = withoutTitle.startsWith("<") && withoutTitle.endsWith(">")
    ? withoutTitle.slice(1, -1)
    : withoutTitle;
  if (unwrapped === "" || unwrapped.startsWith("#") || EXTERNAL_SCHEMES.test(unwrapped)) {
    return undefined;
  }
  const pathOnly = unwrapped.split(/[?#]/, 1)[0];
  return decodeURIComponent(pathOnly);
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function lineAt(source, offset) {
  return source.slice(0, offset).split("\n").length;
}

async function main() {
  const scriptDirectory = dirname(fileURLToPath(import.meta.url));
  const repositoryRoot = resolve(scriptDirectory, "..");
  const failures = await findBrokenArticleLinks({ repositoryRoot });

  if (failures.length === 0) {
    process.stdout.write("Article links verified.\n");
    return;
  }

  for (const failure of failures) {
    process.stderr.write(`${failure.article}:${failure.line} -> ${failure.target}\n`);
  }
  process.stderr.write(`${failures.length} broken article link(s).\n`);
  process.exitCode = 1;
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) await main();
