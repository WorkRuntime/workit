/**
 * Sticky site header for the WorkIt examples site.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import { GitBranch } from "lucide-react";

const workitWordmarkUrl = `${import.meta.env.BASE_URL}workit-wordmark.png`;
const githubUrl = "https://github.com/WorkRuntime/workit";

/** Render the global navigation and WorkIt mark. */
export function SiteHeader() {
  return (
    <header className="sticky top-0 z-20 border-b border-zinc-200 bg-[#f7f8f4]/90 backdrop-blur">
      <div className="mx-auto flex h-16 w-full max-w-[1600px] items-center justify-between px-4 sm:px-6 lg:px-8">
        <div className="flex min-w-0 items-center gap-5">
          <img className="h-10 w-auto shrink-0" src={workitWordmarkUrl} alt="WorkIt" />
          <div className="hidden max-w-[19rem] border-l border-zinc-300 pl-5 text-[0.8rem] font-semibold leading-5 text-zinc-600 sm:block">
            Structured concurrency runtime for TypeScript
          </div>
        </div>
        <nav className="hidden items-center gap-1 md:flex" aria-label="Primary">
          <a className="nav-link" href={githubUrl}>GitHub</a>
          <a className="icon-button" href={githubUrl} aria-label="Open WorkIt on GitHub">
            <GitBranch className="h-4 w-4" aria-hidden="true" />
          </a>
        </nav>
      </div>
    </header>
  );
}
