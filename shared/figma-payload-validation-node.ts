import { type ObjectValue, ValidationContext } from './figma-payload-validation-context';
import {
  validateComponentProperties, validateColor, validateEffect, validateFill, validateKeyedBindings,
  validateMotion, validateTextSegments,
} from './figma-payload-validation-values';
import { validateInnerOverrides, validateScanMetadata, validateTokenRefs } from './figma-payload-validation-node-details';

const NODE_FIELDS = new Set([
  'type', 'name', 'width', 'height', 'layoutMode', 'itemSpacing', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'primaryAxisSizingMode', 'counterAxisSizingMode', 'primaryAxisAlignItems', 'counterAxisAlignItems', 'layoutWrap', 'counterAxisSpacing',
  'layoutSizingHorizontal', 'layoutSizingVertical', 'layoutGrow', 'maxWidth', 'minWidth', 'maxHeight', 'minHeight', 'gridColumnCount',
  'gridRowCount', 'gridRowGap', 'gridColumnGap', 'fills', 'cornerRadius', 'cornerRadii', 'effects', 'opacity', 'backgroundImageUrl',
  'backgroundSize', 'backgroundPosition', 'strokes', 'strokeWeight', 'strokeWeights', 'strokeAlign', 'characters', 'fontFamily',
  'fontStack', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing', 'wordSpacing', 'textAlignHorizontal',
  'textAutoResize', 'textColor', 'textDecoration', 'textCase', 'textTruncation', 'blendMode', 'rotation', 'counterAxisAlignContent',
  'imageUrl', 'svgContent', 'motion', 'clipsContent', 'absolutePosition', 'x', 'y', 'textSegments', 'keyedBindings', 'tokenRefs',
  'componentKey', 'componentId', 'componentName', 'componentProperties', 'innerOverrides', 'figmaScanUnreproducibleInner',
  'figmaScanBindings', 'figmaScanSourceType', 'figmaScanInnerOverrides', 'figmaScanUnbindable', 'children',
]);

const ENUM_FIELDS: Record<string, readonly string[]> = {
  layoutMode: ['HORIZONTAL', 'VERTICAL', 'GRID', 'NONE'],
  primaryAxisSizingMode: ['AUTO', 'FIXED'], counterAxisSizingMode: ['AUTO', 'FIXED'],
  primaryAxisAlignItems: ['MIN', 'CENTER', 'MAX', 'SPACE_BETWEEN'],
  counterAxisAlignItems: ['MIN', 'CENTER', 'MAX', 'BASELINE'], layoutWrap: ['WRAP', 'NO_WRAP'],
  layoutSizingHorizontal: ['FILL', 'FIXED', 'HUG'], layoutSizingVertical: ['FILL', 'FIXED', 'HUG'],
  strokeAlign: ['INSIDE', 'OUTSIDE', 'CENTER'], fontStyle: ['normal', 'italic'],
  textAlignHorizontal: ['LEFT', 'CENTER', 'RIGHT', 'JUSTIFIED'],
  textAutoResize: ['NONE', 'WIDTH_AND_HEIGHT', 'HEIGHT', 'TRUNCATE'],
  textDecoration: ['UNDERLINE', 'STRIKETHROUGH'], textCase: ['UPPER', 'LOWER', 'TITLE'],
  textTruncation: ['ENDING'], counterAxisAlignContent: ['AUTO', 'SPACE_BETWEEN'],
};
const NONNEGATIVE_FIELDS = [
  'width', 'height', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'counterAxisSpacing', 'layoutGrow',
  'maxWidth', 'minWidth', 'maxHeight', 'minHeight', 'gridRowGap', 'gridColumnGap', 'cornerRadius', 'strokeWeight',
  'fontSize', 'fontWeight', 'lineHeight',
] as const;
const FREE_NUMBER_FIELDS = ['itemSpacing', 'letterSpacing', 'wordSpacing', 'rotation', 'x', 'y'] as const;
const ORDINARY_STRING_FIELDS = [
  'backgroundSize', 'backgroundPosition', 'characters', 'fontFamily', 'fontStack', 'blendMode',
  'componentKey', 'componentId', 'componentName',
] as const;
const BOOLEAN_FIELDS = ['clipsContent', 'absolutePosition'] as const;
const FOUR_CORNER_FIELDS = new Set(['tl', 'tr', 'br', 'bl']);
const FOUR_STROKE_FIELDS = new Set(['top', 'right', 'bottom', 'left']);

function required(item: ObjectValue, key: string, path: string, context: ValidationContext): unknown {
  if (!Object.prototype.hasOwnProperty.call(item, key)) context.fail(`${path}.${key}`, 'is required');
  return item[key];
}

function validateNumberRecord(
  value: unknown,
  path: string,
  fields: ReadonlySet<string>,
  context: ValidationContext,
): void {
  context.object(value, path, fields, (record) => {
    for (const key of fields) context.number(required(record, key, path, context), `${path}.${key}`, 0);
  });
}

function validateNodeFields(item: ObjectValue, path: string, context: ValidationContext): void {
  context.enumValue(required(item, 'type', path, context), `${path}.type`, ['FRAME', 'TEXT', 'RECTANGLE', 'IMAGE', 'GROUP', 'INSTANCE'] as const);
  context.string(required(item, 'name', path, context), `${path}.name`);
  for (const [field, values] of Object.entries(ENUM_FIELDS)) if (item[field] !== undefined) {
    context.enumValue(item[field], `${path}.${field}`, values);
  }
  for (const field of NONNEGATIVE_FIELDS) if (item[field] !== undefined) context.number(item[field], `${path}.${field}`, 0);
  for (const field of FREE_NUMBER_FIELDS) if (item[field] !== undefined) context.number(item[field], `${path}.${field}`);
  for (const field of ['gridColumnCount', 'gridRowCount'] as const) if (item[field] !== undefined) {
    context.integer(item[field], `${path}.${field}`);
  }
  if (item.opacity !== undefined) context.number(item.opacity, `${path}.opacity`, 0, 1);
  for (const field of ORDINARY_STRING_FIELDS) if (item[field] !== undefined) context.string(item[field], `${path}.${field}`);
  for (const field of BOOLEAN_FIELDS) if (item[field] !== undefined) context.boolean(item[field], `${path}.${field}`);
  if (item.imageUrl !== undefined) context.string(item.imageUrl, `${path}.imageUrl`, context.limits.imageChars);
  if (item.backgroundImageUrl !== undefined) context.string(item.backgroundImageUrl, `${path}.backgroundImageUrl`, context.limits.imageChars);
  if (item.svgContent !== undefined) context.string(item.svgContent, `${path}.svgContent`, context.limits.svgChars);
}

export function validateNode(value: unknown, path: string, context: ValidationContext, depth = 0): void {
  context.node(path, depth);
  context.object(value, path, NODE_FIELDS, (item) => {
    validateNodeFields(item, path, context);
    for (const key of ['fills', 'strokes'] as const) if (item[key] !== undefined) {
      context.array(item[key], `${path}.${key}`, context.limits.arrayEntries, (entry, i) => validateFill(entry, `${path}.${key}[${i}]`, context));
    }
    if (item.effects !== undefined) context.array(item.effects, `${path}.effects`, context.limits.arrayEntries, (entry, i) => {
      validateEffect(entry, `${path}.effects[${i}]`, context);
    });
    if (item.cornerRadii !== undefined) validateNumberRecord(item.cornerRadii, `${path}.cornerRadii`, FOUR_CORNER_FIELDS, context);
    if (item.strokeWeights !== undefined) validateNumberRecord(item.strokeWeights, `${path}.strokeWeights`, FOUR_STROKE_FIELDS, context);
    if (item.textColor !== undefined) validateColor(item.textColor, `${path}.textColor`, context);
    if (item.textSegments !== undefined) validateTextSegments(item.textSegments, `${path}.textSegments`, context);
    if (item.motion !== undefined) validateMotion(item.motion, `${path}.motion`, context);
    if (item.keyedBindings !== undefined) validateKeyedBindings(item.keyedBindings, `${path}.keyedBindings`, context);
    if (item.tokenRefs !== undefined) validateTokenRefs(item.tokenRefs, `${path}.tokenRefs`, context);
    if (item.componentProperties !== undefined) validateComponentProperties(item.componentProperties, `${path}.componentProperties`, context);
    if (item.innerOverrides !== undefined) validateInnerOverrides(item.innerOverrides, `${path}.innerOverrides`, context);
    validateScanMetadata(item, path, context);
    if (item.children !== undefined) context.array(item.children, `${path}.children`, context.limits.arrayEntries, (child, i) => {
      validateNode(child, `${path}.children[${i}]`, context, depth + 1);
    });
  });
}
