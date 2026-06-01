/**
 * Sticky site header for the WorkIt examples site.
 *
 * @author Admilson B. F. Cossa
 * SPDX-License-Identifier: Apache-2.0
 */

import { GitBranch } from "lucide-react";

const workitLogoUrl = `${import.meta.env.BASE_URL}workit%20logo.png`;
const githubUrl = "https://github.com/WorkRuntime/workit";

/** Render the global navigation and WorkIt mark. */
export function SiteHeader() {
  return (
    <header className="sticky top-0 z-20 border-b border-zinc-200 bg-[#f7f8f4]/90 backdrop-blur">
      <div className="mx-auto flex h-16 w-full max-w-[1600px] items-center justify-between px-4 sm:px-6 lg:px-8">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 overflow-hidden rounded-md border border-zinc-950 bg-white">
            <img className="h-full w-full object-cover" src={workitLogoUrl} alt="" />
          </div>
          <div>
            <div className="font-black">WorkIt</div>
            <div className="text-xs font-medium text-zinc-500">Structured concurrency runtime for TypeScript</div>
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
