export type ExecJsLintSeverity = 'error' | 'warning';

export interface ExecJsLintFinding {
  id: string;
  severity: ExecJsLintSeverity;
  message: string;
  fix: string;
  line: number;
}

interface ExecJsLintRule {
  readonly id: string;
  readonly severity: ExecJsLintSeverity;
  readonly pattern: RegExp;
  readonly message: string;
  readonly fix: string;
  readonly unless?: RegExp;
}

// The order is part of the CLI contract: one pass reports deterministic failures first,
// then receiver-ambiguous heuristics. Keep mechanically decidable checks anchored to the
// `figma` namespace; bare properties can also belong to ordinary data objects and only warn.
export const EXEC_JS_LINT_RULES: readonly ExecJsLintRule[] = [
  {
    id: 'sync-get-node-by-id', severity: 'error',
    pattern: /\bfigma\s*\.\s*getNodeById\s*\(/,
    message: 'figma.getNodeById is unavailable with dynamic-page document access',
    fix: 'use await figma.getNodeByIdAsync(...)',
  },
  {
    id: 'sync-local-text-styles', severity: 'error',
    pattern: /\bfigma\s*\.\s*getLocalTextStyles\s*\(/,
    message: 'figma.getLocalTextStyles is unavailable with dynamic-page document access',
    fix: 'use await figma.getLocalTextStylesAsync()',
  },
  {
    id: 'sync-local-paint-styles', severity: 'error',
    pattern: /\bfigma\s*\.\s*getLocalPaintStyles\s*\(/,
    message: 'figma.getLocalPaintStyles is unavailable with dynamic-page document access',
    fix: 'use await figma.getLocalPaintStylesAsync()',
  },
  {
    id: 'sync-local-effect-styles', severity: 'error',
    pattern: /\bfigma\s*\.\s*getLocalEffectStyles\s*\(/,
    message: 'figma.getLocalEffectStyles is unavailable with dynamic-page document access',
    fix: 'use await figma.getLocalEffectStylesAsync()',
  },
  {
    id: 'sync-current-page-assignment', severity: 'error',
    pattern: /\bfigma\s*\.\s*currentPage\s*=(?!=)/,
    message: 'assigning figma.currentPage is unavailable with dynamic-page document access',
    fix: 'use await figma.setCurrentPageAsync(page)',
  },
  {
    id: 'unsupported-import', severity: 'error',
    pattern: /^\s*import\b(?!\s*[.(])/m,
    message: 'module import declarations are unavailable in the exec-js sandbox',
    fix: 'inline the dependency or use the injected ui helper API',
  },
  {
    id: 'sync-main-component-property', severity: 'warning',
    pattern: /\.\s*mainComponent\b/,
    message: 'the mainComponent property can throw with dynamic-page document access',
    fix: 'use await instance.getMainComponentAsync()',
  },
  {
    id: 'unsupported-require', severity: 'warning',
    pattern: /\brequire\s*\(/,
    message: 'require is normally unavailable in the exec-js sandbox',
    fix: 'inline the dependency or use the injected ui helper API',
  },
  {
    id: 'sync-text-style-assignment', severity: 'warning',
    pattern: /\.\s*textStyleId\s*=(?!=)/,
    message: 'assigning textStyleId can fail under dynamic-page access',
    fix: 'use await node.setTextStyleIdAsync(styleId)',
  },
  {
    id: 'sync-effect-style-assignment', severity: 'warning',
    pattern: /\.\s*effectStyleId\s*=(?!=)/,
    message: 'assigning effectStyleId can fail under dynamic-page access',
    fix: 'use await node.setEffectStyleIdAsync(styleId)',
  },
  {
    id: 'unloaded-font-assignment', severity: 'warning',
    pattern: /(?:\.\s*fontName\s*=(?!=)|\.\s*setRangeFontName\s*\()/,
    unless: /\bfigma\s*\.\s*loadFontAsync\s*\(/,
    message: 'font assignment without a visible loadFontAsync may throw',
    fix: 'await figma.loadFontAsync(font) before assigning the font',
  },
] as const;

/**
 * Mask comments and quoted/template literals while preserving offsets and newlines.
 * This deliberately masks whole template literals, including `${...}` expressions: a
 * false-negative is safer than blocking valid code when a lexical pass is uncertain.
 */
export function maskExecJsLiterals(source: string): string {
  type State = 'code' | 'single' | 'double' | 'template' | 'regex' | 'line-comment' | 'block-comment';
  let state: State = 'code';
  let escaped = false;
  let regexClass = false;
  let canStartRegex = true;
  let out = '';
  const expressionKeywords = new Set([
    'await', 'case', 'delete', 'do', 'else', 'in', 'instanceof', 'new', 'of',
    'return', 'throw', 'typeof', 'void', 'yield',
  ]);

  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    const next = source[i + 1];

    if (state === 'code') {
      if (char === '/' && next === '/') {
        state = 'line-comment';
        out += '  ';
        i++;
      } else if (char === '/' && next === '*') {
        state = 'block-comment';
        out += '  ';
        i++;
      } else if (char === "'") {
        state = 'single';
        escaped = false;
        out += ' ';
      } else if (char === '"') {
        state = 'double';
        escaped = false;
        out += ' ';
      } else if (char === '`') {
        state = 'template';
        escaped = false;
        out += ' ';
      } else if (char === '/' && canStartRegex) {
        // A single-pass lexical hint, not a parser. Ambiguous starts are biased toward regex
        // masking, so uncertainty can hide a finding but cannot hard-reject valid source.
        state = 'regex';
        escaped = false;
        regexClass = false;
        out += ' ';
      } else if (char === '/') {
        out += char;
        canStartRegex = true; // division is followed by an expression
      } else if (/[A-Za-z_$]/.test(char)) {
        let end = i + 1;
        while (end < source.length && /[\w$]/.test(source[end])) end++;
        const token = source.slice(i, end);
        out += token;
        canStartRegex = expressionKeywords.has(token);
        i = end - 1;
      } else if (/\d/.test(char)) {
        out += char;
        canStartRegex = false;
      } else {
        out += char;
        if (!/\s/.test(char)) canStartRegex = char !== '.';
      }
      continue;
    }

    if (state === 'line-comment') {
      if (char === '\n') {
        state = 'code';
        out += '\n';
      } else out += ' ';
      continue;
    }

    if (state === 'block-comment') {
      if (char === '*' && next === '/') {
        state = 'code';
        out += '  ';
        i++;
      } else out += char === '\n' ? '\n' : ' ';
      continue;
    }

    if (state === 'regex') {
      out += char === '\n' ? '\n' : ' ';
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '[') regexClass = true;
      else if (char === ']') regexClass = false;
      else if (char === '/' && !regexClass) {
        state = 'code';
        canStartRegex = false;
      }
      continue;
    }

    const closing = state === 'single' ? "'" : state === 'double' ? '"' : '`';
    if (char === '\n') out += '\n';
    else out += ' ';
    if (escaped) escaped = false;
    else if (char === '\\') escaped = true;
    else if (char === closing) {
      state = 'code';
      canStartRegex = false;
    }
  }
  return out;
}

function firstIndex(pattern: RegExp, source: string): number {
  const match = new RegExp(pattern.source, pattern.flags.replace('g', '')).exec(source);
  return match?.index ?? -1;
}

function lineAt(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (source[i] === '\n') line++;
  return line;
}

export function lintExecJs(source: string): ExecJsLintFinding[] {
  const masked = maskExecJsLiterals(source);
  const findings: ExecJsLintFinding[] = [];
  for (const rule of EXEC_JS_LINT_RULES) {
    const index = firstIndex(rule.pattern, masked);
    if (index < 0 || (rule.unless && firstIndex(rule.unless, masked) >= 0)) continue;
    findings.push({
      id: rule.id,
      severity: rule.severity,
      message: rule.message,
      fix: rule.fix,
      line: lineAt(masked, index),
    });
  }
  return findings;
}
