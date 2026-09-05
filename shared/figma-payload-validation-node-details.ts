import { type ObjectValue, ValidationContext } from './figma-payload-validation-context';
import {
  validateComponentProperties, validateEffect, validateFill, validateKeyedBindings,
  validatePrimitiveRecord, validateStringRecord,
} from './figma-payload-validation-values';

const TOKEN_REF_FIELDS = new Set(['fill', 'stroke', 'textColor', 'radius', 'gap', 'padding']);
const INNER_OVERRIDE_FIELDS = new Set([
  'childKey', 'fields', 'componentKey', 'componentId', 'componentProperties', 'visual', 'figmaScanFillSize',
]);
const INNER_VISUAL_FIELDS = new Set([
  'fills', 'strokes', 'effects', 'effectStyleId', 'visible', 'opacity', 'keyedBindings',
]);
const FILL_SIZE_FIELDS = new Set(['width', 'height']);

function required(item: ObjectValue, key: string, path: string, context: ValidationContext): unknown {
  if (!Object.prototype.hasOwnProperty.call(item, key)) context.fail(`${path}.${key}`, 'is required');
  return item[key];
}

export function validateTokenRefs(value: unknown, path: string, context: ValidationContext): void {
  context.object(value, path, TOKEN_REF_FIELDS, (refs) => {
    for (const key of TOKEN_REF_FIELDS) if (refs[key] !== undefined) context.string(refs[key], `${path}.${key}`);
  });
}

function validateInnerVisual(value: unknown, path: string, context: ValidationContext): void {
  context.object(value, path, INNER_VISUAL_FIELDS, (visual) => {
    for (const key of ['fills', 'strokes'] as const) if (visual[key] !== undefined) {
      context.array(visual[key], `${path}.${key}`, context.limits.arrayEntries, (entry, i) => {
        validateFill(entry, `${path}.${key}[${i}]`, context);
      });
    }
    if (visual.effects !== undefined) context.array(
      visual.effects,
      `${path}.effects`,
      context.limits.arrayEntries,
      (entry, i) => validateEffect(entry, `${path}.effects[${i}]`, context),
    );
    if (visual.effectStyleId !== undefined) context.string(visual.effectStyleId, `${path}.effectStyleId`);
    if (visual.visible !== undefined) context.boolean(visual.visible, `${path}.visible`);
    if (visual.opacity !== undefined) context.number(visual.opacity, `${path}.opacity`, 0, 1);
    if (visual.keyedBindings !== undefined) validateKeyedBindings(visual.keyedBindings, `${path}.keyedBindings`, context);
  });
}

export function validateInnerOverrides(value: unknown, path: string, context: ValidationContext): void {
  context.array(value, path, context.limits.arrayEntries, (entry, i) => {
    const entryPath = `${path}[${i}]`;
    context.object(entry, entryPath, INNER_OVERRIDE_FIELDS, (override) => {
      context.string(required(override, 'childKey', entryPath, context), `${entryPath}.childKey`);
      validatePrimitiveRecord(required(override, 'fields', entryPath, context), `${entryPath}.fields`, context);
      for (const key of ['componentKey', 'componentId'] as const) if (override[key] !== undefined) {
        context.string(override[key], `${entryPath}.${key}`);
      }
      if (override.componentProperties !== undefined) {
        validateComponentProperties(override.componentProperties, `${entryPath}.componentProperties`, context);
      }
      if (override.visual !== undefined) validateInnerVisual(override.visual, `${entryPath}.visual`, context);
      if (override.figmaScanFillSize !== undefined) {
        context.object(override.figmaScanFillSize, `${entryPath}.figmaScanFillSize`, FILL_SIZE_FIELDS, (size) => {
          for (const key of FILL_SIZE_FIELDS) if (size[key] !== undefined) {
            context.number(size[key], `${entryPath}.figmaScanFillSize.${key}`, 0);
          }
        });
      }
    });
  });
}

export function validateScanMetadata(item: ObjectValue, path: string, context: ValidationContext): void {
  if (item.figmaScanBindings !== undefined) validateStringRecord(item.figmaScanBindings, `${path}.figmaScanBindings`, context);
  if (item.figmaScanSourceType !== undefined) context.string(item.figmaScanSourceType, `${path}.figmaScanSourceType`);
  for (const key of ['figmaScanUnreproducibleInner', 'figmaScanInnerOverrides', 'figmaScanUnbindable'] as const) {
    if (item[key] !== undefined) context.array(item[key], `${path}.${key}`, context.limits.arrayEntries, (entry, i) => {
      context.string(entry, `${path}.${key}[${i}]`);
    });
  }
}
