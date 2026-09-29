import {
  AttachmentResponse,
  CSRF_HEADER,
  CSRF_HEADER_VALUE,
  UserResponse,
  type Attachment,
  type Me,
} from '@hearth/shared';
import {
  API_PREFIX,
  ApiError,
  apiFetch,
  errorFromResponse,
  NETWORK_ERROR_MESSAGE,
  type ResponseSchema,
} from './client';

export interface UploadOptions {
  signal?: AbortSignal;
  /** Called with the fraction of the request body sent so far (0–1). */
  onProgress?: (fraction: number) => void;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * The result of a finished upload request: the parsed 2xx body, or the `ApiError` for anything else
 * (including a proxy's non-JSON 413, see `errorFromResponse`).
 */
export function parseUploadResponse<T>(status: number, body: string, schema: ResponseSchema<T>): T {
  const json = parseJson(body);
  if (status < 200 || status >= 300) throw errorFromResponse(status, json);
  const parsed = json === undefined ? undefined : schema.safeParse(json);
  if (!parsed?.success) throw new ApiError(status, 'INTERNAL', 'The server sent an unexpected response.');
  return parsed.data;
}

function abortError(): DOMException {
  return new DOMException('The upload was aborted.', 'AbortError');
}

/**
 * Sends `file` as the single multipart part `file` (CONTRACTS B.7a rule 3) with the session cookie
 * and the CSRF header. Uses XMLHttpRequest for upload progress. The browser sets the multipart
 * Content-Type (with its boundary) itself; it must never be set by hand. Rejects with `ApiError`, or
 * with an `AbortError` DOMException when `signal` aborts.
 */
export function uploadFile<T>(
  path: string,
  method: 'POST' | 'PUT',
  file: Blob,
  filename: string,
  schema: ResponseSchema<T>,
  { signal, onProgress }: UploadOptions = {},
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const body = new FormData();
    body.append('file', file, filename);

    const xhr = new XMLHttpRequest();
    const onAbortSignal = () => {
      xhr.abort();
    };
    const cleanup = () => {
      signal?.removeEventListener('abort', onAbortSignal);
    };

    xhr.open(method, `${API_PREFIX}${path}`);
    // A same-origin XHR always carries the session cookie (the equivalent of `credentials: 'same-origin'`).
    xhr.responseType = 'text';
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.setRequestHeader(CSRF_HEADER, CSRF_HEADER_VALUE);

    if (onProgress) {
      xhr.upload.addEventListener('progress', (event) => {
        if (event.lengthComputable && event.total > 0) onProgress(event.loaded / event.total);
      });
    }
    xhr.addEventListener('load', () => {
      cleanup();
      try {
        resolve(parseUploadResponse(xhr.status, xhr.responseText, schema));
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    xhr.addEventListener('error', () => {
      cleanup();
      reject(new ApiError(0, 'INTERNAL', NETWORK_ERROR_MESSAGE));
    });
    xhr.addEventListener('abort', () => {
      cleanup();
      reject(abortError());
    });
    signal?.addEventListener('abort', onAbortSignal, { once: true });

    xhr.send(body);
  });
}

/** POST /attachments — an unattached upload, claimed later by a message send (row 21). */
export async function uploadAttachment(file: File, options?: UploadOptions): Promise<Attachment> {
  const res = await uploadFile('/attachments', 'POST', file, file.name, AttachmentResponse, options);
  return res.attachment;
}

/** PUT /me/avatar — png/jpeg/webp up to 2 MB. */
export async function setAvatar(file: File): Promise<Me> {
  const res = await uploadFile('/me/avatar', 'PUT', file, file.name, UserResponse);
  return res.user;
}

/** DELETE /me/avatar */
export async function removeAvatar(): Promise<Me> {
  const res = await apiFetch('/me/avatar', { method: 'DELETE', schema: UserResponse });
  return res.user;
}
