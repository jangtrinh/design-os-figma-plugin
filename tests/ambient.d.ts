declare module 'ease-design/lint' {
  export interface LintFinding {
    readonly severity: 'error' | 'warning' | 'info' | (string & {});
    readonly rule?: string;
    readonly message?: string;
    readonly line?: number;
  }

  export interface LintReport {
    readonly errorCount: number;
    readonly warningCount?: number;
    readonly findings?: readonly LintFinding[];
  }

  export type ContentCheck = (source: string) => readonly LintFinding[];

  export const GATE_FAMILIES: readonly string[];
  export const allContentChecks: readonly ContentCheck[];
  export function lintA11y(source: string): LintReport;
  export function lintDsUsage(source: string): LintReport;
  export function lintLayout(source: string): LintReport;
  export function lintTaste(source: string): LintReport;
}
