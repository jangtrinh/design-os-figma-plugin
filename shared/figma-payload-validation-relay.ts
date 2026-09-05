import type { FigmaExportPayload } from './figma-payload-types';
import { validateImportPayload } from './figma-payload-validation';

export interface HtmlImportRelayResult {
  requestId: string;
  expectedFile?: string;
  payload: unknown;
  placement: { x?: unknown; y?: unknown; parentId?: unknown; replaceId?: unknown };
}

export interface DirectImportRelayRequest {
  requestId: string;
  expectedFile?: string;
  params: unknown;
  readOnly?: boolean;
}

export interface MainImportMessage {
  pluginMessage: {
    requestId: string;
    cmd: 'IMPORT_PAYLOAD';
    expectedFile?: string;
    params: {
      payload: FigmaExportPayload;
      x?: number;
      y?: number;
      parentId?: string;
      replaceId?: string;
    };
    readOnly?: true;
  };
}

/** Admit a direct wire import before the relay gives it any main-thread authority. */
export function forwardValidatedDirectImport(
  request: DirectImportRelayRequest,
  forward: (message: MainImportMessage) => void,
): void {
  const admission = validateImportPayload(request.params);
  forward({
    pluginMessage: {
      requestId: request.requestId,
      cmd: 'IMPORT_PAYLOAD',
      params: { payload: admission.payload, ...admission.placement },
      expectedFile: request.expectedFile,
      ...(request.readOnly === true && { readOnly: true as const }),
    },
  });
}

/** Admit a renderer result before the relay gives it any main-thread authority. */
export function forwardValidatedHtmlImport(
  result: HtmlImportRelayResult,
  forward: (message: MainImportMessage) => void,
): void {
  const admission = validateImportPayload({ payload: result.payload, ...result.placement });
  forward({
    pluginMessage: {
      requestId: result.requestId,
      cmd: 'IMPORT_PAYLOAD',
      expectedFile: result.expectedFile,
      params: { payload: admission.payload, ...admission.placement },
    },
  });
}
