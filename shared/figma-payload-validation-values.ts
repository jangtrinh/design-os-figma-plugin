import { type ObjectValue, ValidationContext } from './figma-payload-validation-context';

const COLOR_FIELDS = new Set(['r', 'g', 'b', 'a']);
const FILL_FIELDS = new Set(['type', 'color', 'gradientStops', 'gradientTransform']);
const EFFECT_FIELDS = new Set(['type', 'offset', 'radius', 'spread', 'color']);
const OFFSET_FIELDS = new Set(['x', 'y']);
const KEYED_BINDING_FIELDS = new Set(['key', 'name']);
const TEXT_SEGMENT_FIELDS = new Set([
  'characters', 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight',
  'letterSpacing', 'textColor', 'textDecoration', 'textCase',
]);
const MOTION_FIELDS = new Set(['steps', 'durationSec', 'easing']);
const MOTION_STEP_FIELDS = new Set(['offset', 'style']);
const MOTION_STYLE_FIELDS = new Set(['opacity', 'transform']);

function required(item: ObjectValue, key: string, path: string, context: ValidationContext): unknown {
  if (!Object.prototype.hasOwnProperty.call(item, key)) context.fail(`${path}.${key}`, 'is required');
  return item[key];
}

export function validateColor(value: unknown, path: string, context: ValidationContext): void {
  context.object(value, path, COLOR_FIELDS, (item) => {
    for (const key of COLOR_FIELDS) context.number(required(item, key, path, context), `${path}.${key}`, 0, 1);
  });
}

export function validateFill(value: unknown, path: string, context: ValidationContext): void {
  context.object(value, path, FILL_FIELDS, (item) => {
    const type = context.enumValue(required(item, 'type', path, context), `${path}.type`, [
      'SOLID', 'GRADIENT_LINEAR', 'GRADIENT_RADIAL', 'GRADIENT_ANGULAR',
    ] as const);
    if (type === 'SOLID') {
      validateColor(required(item, 'color', path, context), `${path}.color`, context);
      if (item.gradientStops !== undefined || item.gradientTransform !== undefined) {
        context.fail(path, 'SOLID fills must not contain gradient fields');
      }
      return;
    }
    if (item.color !== undefined) context.fail(`${path}.color`, 'is only supported for SOLID fills');
    context.array(required(item, 'gradientStops', path, context), `${path}.gradientStops`, context.limits.arrayEntries, (stop, i) => {
      const stopPath = `${path}.gradientStops[${i}]`;
      context.object(stop, stopPath, new Set(['color', 'position']), (entry) => {
        validateColor(required(entry, 'color', stopPath, context), `${stopPath}.color`, context);
        context.number(required(entry, 'position', stopPath, context), `${stopPath}.position`, 0, 1);
      });
    }, 2);
    context.array(required(item, 'gradientTransform', path, context), `${path}.gradientTransform`, 2, (row, i) => {
      context.array(row, `${path}.gradientTransform[${i}]`, 3, (entry, j) => {
        context.number(entry, `${path}.gradientTransform[${i}][${j}]`);
      }, 3);
    }, 2);
  });
}

export function validateEffect(value: unknown, path: string, context: ValidationContext): void {
  context.object(value, path, EFFECT_FIELDS, (item) => {
    context.enumValue(required(item, 'type', path, context), `${path}.type`, [
      'DROP_SHADOW', 'INNER_SHADOW', 'LAYER_BLUR', 'BACKGROUND_BLUR',
    ] as const);
    context.number(required(item, 'radius', path, context), `${path}.radius`, 0);
    if (item.spread !== undefined) context.number(item.spread, `${path}.spread`);
    if (item.color !== undefined) validateColor(item.color, `${path}.color`, context);
    if (item.offset !== undefined) context.object(item.offset, `${path}.offset`, OFFSET_FIELDS, (offset) => {
      context.number(required(offset, 'x', `${path}.offset`, context), `${path}.offset.x`);
      context.number(required(offset, 'y', `${path}.offset`, context), `${path}.offset.y`);
    });
  });
}

function validateRecord(
  value: unknown,
  path: string,
  context: ValidationContext,
  visit: (entry: unknown, entryPath: string) => void,
): void {
  context.object(value, path, null, (item) => {
    for (const key in item) {
      if (Object.prototype.hasOwnProperty.call(item, key)) visit(item[key], `${path}.${key}`);
    }
  });
}

export function validateKeyedBindings(value: unknown, path: string, context: ValidationContext): void {
  validateRecord(value, path, context, (entry, entryPath) => {
    context.object(entry, entryPath, KEYED_BINDING_FIELDS, (binding) => {
      context.string(required(binding, 'key', entryPath, context), `${entryPath}.key`);
      if (binding.name !== undefined) context.string(binding.name, `${entryPath}.name`);
    });
  });
}

export function validateStringRecord(value: unknown, path: string, context: ValidationContext): void {
  validateRecord(value, path, context, (entry, entryPath) => context.string(entry, entryPath));
}

export function validatePrimitiveRecord(value: unknown, path: string, context: ValidationContext): void {
  validateRecord(value, path, context, (entry, entryPath) => {
    if (typeof entry === 'number') context.number(entry, entryPath);
    else context.string(entry, entryPath);
  });
}

export function validateComponentProperties(value: unknown, path: string, context: ValidationContext): void {
  validateRecord(value, path, context, (entry, entryPath) => {
    if (typeof entry === 'boolean') context.boolean(entry, entryPath);
    else context.string(entry, entryPath);
  });
}

export function validateTextSegments(value: unknown, path: string, context: ValidationContext): void {
  context.array(value, path, context.limits.arrayEntries, (entry, i) => {
    const entryPath = `${path}[${i}]`;
    context.object(entry, entryPath, TEXT_SEGMENT_FIELDS, (segment) => {
      context.string(required(segment, 'characters', entryPath, context), `${entryPath}.characters`);
      if (segment.fontFamily !== undefined) context.string(segment.fontFamily, `${entryPath}.fontFamily`);
      for (const key of ['fontSize', 'fontWeight', 'lineHeight'] as const) if (segment[key] !== undefined) {
        context.number(segment[key], `${entryPath}.${key}`, 0);
      }
      if (segment.letterSpacing !== undefined) context.number(segment.letterSpacing, `${entryPath}.letterSpacing`);
      if (segment.fontStyle !== undefined) context.enumValue(segment.fontStyle, `${entryPath}.fontStyle`, ['normal', 'italic'] as const);
      if (segment.textDecoration !== undefined) context.enumValue(segment.textDecoration, `${entryPath}.textDecoration`, ['UNDERLINE', 'STRIKETHROUGH'] as const);
      if (segment.textCase !== undefined) context.enumValue(segment.textCase, `${entryPath}.textCase`, ['UPPER', 'LOWER', 'TITLE'] as const);
      if (segment.textColor !== undefined) validateColor(segment.textColor, `${entryPath}.textColor`, context);
    });
  });
}

export function validateMotion(value: unknown, path: string, context: ValidationContext): void {
  context.object(value, path, MOTION_FIELDS, (motion) => {
    context.number(required(motion, 'durationSec', path, context), `${path}.durationSec`, 0);
    if (motion.easing !== undefined) context.string(motion.easing, `${path}.easing`);
    context.array(required(motion, 'steps', path, context), `${path}.steps`, context.limits.motionSteps, (entry, i) => {
      const entryPath = `${path}.steps[${i}]`;
      context.object(entry, entryPath, MOTION_STEP_FIELDS, (step) => {
        context.number(required(step, 'offset', entryPath, context), `${entryPath}.offset`, 0, 1);
        context.object(required(step, 'style', entryPath, context), `${entryPath}.style`, MOTION_STYLE_FIELDS, (style) => {
          for (const key of MOTION_STYLE_FIELDS) if (style[key] !== undefined) context.string(style[key], `${entryPath}.style.${key}`);
        });
      });
    });
  });
}
