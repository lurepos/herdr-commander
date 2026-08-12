import { isAbsolute, relative, resolve } from "node:path";
import type { ProblemMatcher, ProblemPattern } from "./task.js";

export type ProblemSeverity = "error" | "warning" | "info";

export interface Problem {
  owner: string;
  file: string;
  line: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
  severity: ProblemSeverity;
  message: string;
  code?: string;
  source?: string;
}

const builtInMatchers: Record<string, ProblemMatcher> = {
  "$tsc": {
    owner: "typescript",
    source: "ts",
    fileLocation: "relative",
    pattern: { regexp: "^(.*)\\((\\d+),(\\d+)\\):\\s+(error|warning)\\s+(TS\\d+):\\s+(.*)$", file: 1, line: 2, column: 3, severity: 4, code: 5, message: 6 },
  },
};

function patternList(matcher: ProblemMatcher): ProblemPattern[] {
  if (!matcher.pattern) throw new Error("problem matcher has no pattern");
  const patterns = Array.isArray(matcher.pattern) ? matcher.pattern : [matcher.pattern];
  return patterns.map((pattern) => typeof pattern === "string" ? { regexp: pattern } : pattern);
}

function normalizeMatcher(value: string | ProblemMatcher): ProblemMatcher {
  if (typeof value === "string") {
    const matcher = builtInMatchers[value];
    if (!matcher) throw new Error(`unsupported problem matcher: ${value}`);
    return matcher;
  }
  return value;
}

function group(match: RegExpExecArray, index: number | undefined): string | undefined {
  return index === undefined ? undefined : match[index];
}

function numberGroup(match: RegExpExecArray, index: number | undefined, name: string): number | undefined {
  const value = group(match, index);
  if (value === undefined || value === "") return undefined;
  const result = Number(value);
  if (!Number.isInteger(result) || result < 1) throw new Error(`problem matcher ${name} must be a positive integer`);
  return result;
}

function resolveFile(file: string, matcher: ProblemMatcher, workspaceCwd: string): string {
  const location = matcher.fileLocation ?? "absolute";
  const candidate = location === "absolute" ? file : location === "relative" ? resolve(workspaceCwd, file) : resolve(workspaceCwd, location[1], file);
  const relativePath = relative(workspaceCwd, candidate);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) throw new Error(`problem path is outside workspace: ${file}`);
  return candidate;
}

function severity(value: string | undefined, fallback: ProblemSeverity): ProblemSeverity {
  if (!value) return fallback;
  if (value === "error" || value === "warning" || value === "info") return value;
  if (value === "1") return "warning";
  if (value === "2") return "info";
  return fallback;
}

export function parseProblems(output: string, matchers: string | ProblemMatcher | Array<string | ProblemMatcher>, context: { workspaceCwd: string; taskLabel: string }): Problem[] {
  const values = Array.isArray(matchers) ? matchers : [matchers];
  const problems: Problem[] = [];
  for (const value of values) {
    const matcher = normalizeMatcher(value);
    const patterns = patternList(matcher);
    for (const pattern of patterns) {
      let regexp: RegExp;
      try { regexp = new RegExp(pattern.regexp); }
      catch (error) { throw new Error(`invalid problem matcher regexp: ${error instanceof Error ? error.message : String(error)}`); }
      for (const line of output.split(/\r?\n/)) {
        const match = regexp.exec(line);
        if (!match) continue;
        const fileValue = group(match, pattern.file);
        const lineValue = numberGroup(match, pattern.line, "line");
        const message = group(match, pattern.message) ?? line;
        if (!fileValue || !lineValue || !message) continue;
        const column = numberGroup(match, pattern.column, "column");
        const endLine = numberGroup(match, pattern.endLine, "endLine");
        const endColumn = numberGroup(match, pattern.endColumn, "endColumn");
        const code = group(match, pattern.code);
        const problem: Problem = {
          owner: matcher.owner ?? context.taskLabel,
          file: resolveFile(fileValue, matcher, context.workspaceCwd),
          line: lineValue,
          severity: severity(group(match, pattern.severity), matcher.severity ?? "error"),
          message,
          ...(column === undefined ? {} : { column }),
          ...(endLine === undefined ? {} : { endLine }),
          ...(endColumn === undefined ? {} : { endColumn }),
          ...(code === undefined ? {} : { code }),
          ...(matcher.source === undefined ? {} : { source: matcher.source }),
        };
        problems.push(problem);
      }
    }
  }
  const unique = new Map(problems.map((problem) => [`${problem.file}:${problem.line}:${problem.column ?? ""}:${problem.message}`, problem]));
  return [...unique.values()];
}
