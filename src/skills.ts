// Chat "skills": leading-slash commands the user can invoke in the agent chat.
// Typing "/" at the start of a message opens a menu; selecting one autocompletes
// the textarea to a literal "/name " prefix the agent recognizes.
//
// The list is dynamic: the built-in `/search` (handled deterministically in the
// agent) plus any Pi skills discovered from installed packages, exposed as
// `/skill:<name>` (Pi expands these inside session.prompt). Populated from
// plugins/list — see src/api/plugins.ts.
import { signal } from "@preact/signals";

export interface Skill {
  name: string;
  hint: string;
}

export const BUILTIN_SKILLS: Skill[] = [
  { name: "search", hint: "Search across todos, lists, books, and artifacts" },
];

export const skills = signal<Skill[]>([...BUILTIN_SKILLS]);

/** Merge Pi-discovered skills (from installed packages) with the built-ins. */
export function setPiSkills(piSkills: { name: string; hint?: string }[]): void {
  const extra: Skill[] = piSkills.map((s) => ({
    name: `skill:${s.name}`,
    hint: s.hint ?? "Pi skill",
  }));
  skills.value = [...BUILTIN_SKILLS, ...extra];
}
