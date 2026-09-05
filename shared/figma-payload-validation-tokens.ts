import type { FigmaExportTokens } from './figma-payload-types';
import { type ObjectValue, ValidationContext } from './figma-payload-validation-context';
import { validateColor, validateEffect } from './figma-payload-validation-values';

const TOKEN_FIELDS = new Set(['colors', 'typography', 'spacing', 'radii', 'shadows']);
const COLOR_TOKEN_FIELDS = new Set(['name', 'hex', 'color']);
const TYPE_TOKEN_FIELDS = new Set(['name', 'family', 'size', 'weight', 'lineHeight', 'letterSpacing']);
const VALUE_TOKEN_FIELDS = new Set(['name', 'value']);
const SHADOW_TOKEN_FIELDS = new Set(['name', 'css', 'effect']);

function required(item: ObjectValue, key: string, path: string, context: ValidationContext): unknown {
  if (!Object.prototype.hasOwnProperty.call(item, key)) context.fail(`${path}.${key}`, 'is required');
  return item[key];
}

/** Legacy absent/null token groups normalize to arrays; the admitted output has the exact token shape. */
export function validateTokens(value: unknown, path: string, context: ValidationContext): FigmaExportTokens {
  return context.object(value, path, TOKEN_FIELDS, (tokens) => {
    const groups = {
      colors: tokens.colors ?? [],
      typography: tokens.typography ?? [],
      spacing: tokens.spacing ?? [],
      radii: tokens.radii ?? [],
      shadows: tokens.shadows ?? [],
    };
    context.array(groups.colors, `${path}.colors`, context.limits.tokenGroup, (entry, i) => {
      const entryPath = `${path}.colors[${i}]`;
      context.object(entry, entryPath, COLOR_TOKEN_FIELDS, (token) => {
        context.string(required(token, 'name', entryPath, context), `${entryPath}.name`);
        context.string(required(token, 'hex', entryPath, context), `${entryPath}.hex`);
        validateColor(required(token, 'color', entryPath, context), `${entryPath}.color`, context);
      });
    });
    context.array(groups.typography, `${path}.typography`, context.limits.tokenGroup, (entry, i) => {
      const entryPath = `${path}.typography[${i}]`;
      context.object(entry, entryPath, TYPE_TOKEN_FIELDS, (token) => {
        context.string(required(token, 'name', entryPath, context), `${entryPath}.name`);
        context.string(required(token, 'family', entryPath, context), `${entryPath}.family`);
        context.number(required(token, 'size', entryPath, context), `${entryPath}.size`, 0);
        context.number(required(token, 'weight', entryPath, context), `${entryPath}.weight`, 0);
        if (token.lineHeight !== undefined) context.number(token.lineHeight, `${entryPath}.lineHeight`, 0);
        if (token.letterSpacing !== undefined) context.number(token.letterSpacing, `${entryPath}.letterSpacing`);
      });
    });
    for (const key of ['spacing', 'radii'] as const) context.array(
      groups[key],
      `${path}.${key}`,
      context.limits.tokenGroup,
      (entry, i) => {
        const entryPath = `${path}.${key}[${i}]`;
        context.object(entry, entryPath, VALUE_TOKEN_FIELDS, (token) => {
          context.string(required(token, 'name', entryPath, context), `${entryPath}.name`);
          context.number(required(token, 'value', entryPath, context), `${entryPath}.value`);
        });
      },
    );
    context.array(groups.shadows, `${path}.shadows`, context.limits.tokenGroup, (entry, i) => {
      const entryPath = `${path}.shadows[${i}]`;
      context.object(entry, entryPath, SHADOW_TOKEN_FIELDS, (token) => {
        context.string(required(token, 'name', entryPath, context), `${entryPath}.name`);
        context.string(required(token, 'css', entryPath, context), `${entryPath}.css`);
        validateEffect(required(token, 'effect', entryPath, context), `${entryPath}.effect`, context);
      });
    });
    return groups as FigmaExportTokens;
  });
}
