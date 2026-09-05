import type { FigmaExportPayload } from './figma-payload-types';
import {
  type ImportPayloadLimits, type ObjectValue, ValidationContext,
} from './figma-payload-validation-context';
import { validateNode } from './figma-payload-validation-node';
import { validateTokens } from './figma-payload-validation-tokens';

export { IMPORT_PAYLOAD_LIMITS, PayloadValidationError } from './figma-payload-validation-context';
export type { ImportPayloadLimits } from './figma-payload-validation-context';

export interface ImportPayloadAdmission {
  payload: FigmaExportPayload;
  placement: { x?: number; y?: number; parentId?: string; replaceId?: string };
}

const PAYLOAD_FIELDS = new Set(['version', 'name', 'width', 'height', 'tokens', 'rootNode']);
const PLACEMENT_FIELDS = new Set(['x', 'y', 'parentId', 'replaceId']);
const WRAPPED_FIELDS = new Set(['payload', ...PLACEMENT_FIELDS]);
const DIRECT_FIELDS = new Set([...PAYLOAD_FIELDS, ...PLACEMENT_FIELDS]);

function required(item: ObjectValue, key: string, path: string, context: ValidationContext): unknown {
  if (!Object.prototype.hasOwnProperty.call(item, key)) context.fail(`${path}.${key}`, 'is required');
  return item[key];
}

function validatePayloadFields(
  payload: ObjectValue,
  path: string,
  context: ValidationContext,
): FigmaExportPayload {
  const version = context.number(required(payload, 'version', path, context), `${path}.version`);
  if (version !== 1) context.fail(`${path}.version`, 'must be 1');
  const name = context.string(required(payload, 'name', path, context), `${path}.name`);
  const width = context.number(required(payload, 'width', path, context), `${path}.width`, 0);
  const height = context.number(required(payload, 'height', path, context), `${path}.height`, 0);
  const tokens = validateTokens(payload.tokens ?? {}, `${path}.tokens`, context);
  const rootNode = required(payload, 'rootNode', path, context);
  validateNode(rootNode, `${path}.rootNode`, context);
  return { version: 1, name, width, height, tokens, rootNode: rootNode as FigmaExportPayload['rootNode'] };
}

function validatePlacement(source: ObjectValue, context: ValidationContext): ImportPayloadAdmission['placement'] {
  const placement: ImportPayloadAdmission['placement'] = {};
  for (const key of ['x', 'y'] as const) if (source[key] !== undefined) {
    placement[key] = context.number(source[key], `params.${key}`);
  }
  for (const key of ['parentId', 'replaceId'] as const) if (source[key] !== undefined) {
    placement[key] = context.string(source[key], `params.${key}`);
  }
  return placement;
}

/** Closed, bounded admission for wrapped and legacy unwrapped IMPORT_PAYLOAD input. */
export function validateImportPayload(
  params: unknown,
  limitOverrides: Partial<ImportPayloadLimits> = {},
): ImportPayloadAdmission {
  const context = new ValidationContext(limitOverrides);
  const looksWrapped = !!params && typeof params === 'object' && !Array.isArray(params)
    && Object.prototype.hasOwnProperty.call(params, 'payload');
  return context.object(params, 'params', looksWrapped ? WRAPPED_FIELDS : DIRECT_FIELDS, (envelope) => {
    const payload = looksWrapped
      ? context.object(required(envelope, 'payload', 'params', context), 'payload', PAYLOAD_FIELDS, (value) => (
        validatePayloadFields(value, 'payload', context)
      ))
      : validatePayloadFields(envelope, 'payload', context);
    return { payload, placement: validatePlacement(envelope, context) };
  });
}
