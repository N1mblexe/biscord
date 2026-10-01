import { AttachmentResponse, CSRF_HEADER, CSRF_HEADER_VALUE } from '@hearth/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiFetch } from './client';
import { attachmentUploadError, fileTooLargeMessage } from '../lib/attachments';
import { avatarUploadError } from '../lib/avatar';
import { errorMessage } from './errors';
import { deleteAttachment, parseUploadResponse, uploadAttachment } from './uploads';

const attachment = {
  id: '6f1c1a52-8b0a-4c5e-9d43-1f2e3d4c5b6a',
  filename: 'report.pdf',
  mimeType: 'application/pdf',
  sizeBytes: 2048,
  url: '/api/attachments/6f1c1a52-8b0a-4c5e-9d43-1f2e3d4c5b6a/report.pdf',
  inline: false,
};

const CADDY_413 = '<html><body><h1>413 Request Entity Too Large</h1></body></html>';

function catchApiError(fn: () => unknown): ApiError {
  try {
    fn();
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
  throw new Error('expected an ApiError');
}

async function rejectsApiError(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
  throw new Error('expected the request to fail');
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const errorBody = (code: string, message: string): string => JSON.stringify({ error: { code, message } });

describe('disk-fill guard alerts (CONTRACTS B.7a rule 8)', () => {
  const quota = () =>
    catchApiError(() =>
      parseUploadResponse(409, errorBody('UPLOAD_QUOTA', 'server wording'), AttachmentResponse),
    );
  const full = () =>
    catchApiError(() =>
      parseUploadResponse(507, errorBody('STORAGE_FULL', 'server wording'), AttachmentResponse),
    );

  it('a 409 UPLOAD_QUOTA shows the fixed quota text for attachments and avatars', () => {
    const err = quota();
    expect(err.status).toBe(409);
    expect(err.code).toBe('UPLOAD_QUOTA');
    const text = 'Too many files waiting to be sent. Send or remove some first.';
    expect(attachmentUploadError(err)).toBe(text);
    expect(avatarUploadError(err)).toBe(text);
  });

  it('a 507 STORAGE_FULL shows the fixed storage text for attachments and avatars', () => {
    const err = full();
    expect(err.status).toBe(507);
    expect(err.code).toBe('STORAGE_FULL');
    const text = 'The server is out of storage space. Tell an admin.';
    expect(attachmentUploadError(err)).toBe(text);
    expect(avatarUploadError(err)).toBe(text);
  });

  it('the other upload alerts are unchanged', () => {
    const tooLarge = catchApiError(() => parseUploadResponse(413, CADDY_413, AttachmentResponse));
    expect(attachmentUploadError(tooLarge)).toBe(fileTooLargeMessage());
    expect(avatarUploadError(tooLarge)).toBe('Avatar must be at most 2 MB.');
    const unsupported = catchApiError(() =>
      parseUploadResponse(415, errorBody('UNSUPPORTED_MEDIA', 'Unsupported file type'), AttachmentResponse),
    );
    expect(avatarUploadError(unsupported)).toBe('Avatar must be a PNG, JPEG or WebP image.');
    const limited = new ApiError(429, 'RATE_LIMITED', 'Too many requests, try again later');
    expect(attachmentUploadError(limited)).toBe('Too many requests, try again later');
  });
});

describe('413 mapping (CONTRACTS B.7a rule 7)', () => {
  it('maps a non-JSON 413 (the proxy cap) to PAYLOAD_TOO_LARGE', () => {
    const err = catchApiError(() => parseUploadResponse(413, CADDY_413, AttachmentResponse));
    expect(err.status).toBe(413);
    expect(err.code).toBe('PAYLOAD_TOO_LARGE');
    expect(errorMessage(err, { PAYLOAD_TOO_LARGE: 'File is too large (max 25 MB).' })).toBe(
      'File is too large (max 25 MB).',
    );
  });

  it('maps an empty or non-ApiErrorBody JSON 413 to PAYLOAD_TOO_LARGE', () => {
    expect(catchApiError(() => parseUploadResponse(413, '', AttachmentResponse)).code).toBe(
      'PAYLOAD_TOO_LARGE',
    );
    expect(catchApiError(() => parseUploadResponse(413, '{"message":"x"}', AttachmentResponse)).code).toBe(
      'PAYLOAD_TOO_LARGE',
    );
  });

  it("keeps the server's own JSON 413", () => {
    const body = JSON.stringify({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'File exceeds 25 MB' } });
    const err = catchApiError(() => parseUploadResponse(413, body, AttachmentResponse));
    expect(err.code).toBe('PAYLOAD_TOO_LARGE');
    expect(err.message).toBe('File exceeds 25 MB');
  });

  it('keeps other non-JSON errors INTERNAL', () => {
    expect(catchApiError(() => parseUploadResponse(502, 'Bad Gateway', AttachmentResponse)).code).toBe(
      'INTERNAL',
    );
  });

  it('applies to apiFetch as well (JSON and non-JSON bodies)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(CADDY_413, { status: 413 }))),
    );
    const proxy = await rejectsApiError(apiFetch('/me/avatar', { method: 'DELETE' }));
    expect(proxy.code).toBe('PAYLOAD_TOO_LARGE');

    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: { code: 'VALIDATION', message: 'nope' } }), { status: 413 }),
        ),
      ),
    );
    const json = await rejectsApiError(apiFetch('/me/avatar', { method: 'DELETE' }));
    expect(json.code).toBe('VALIDATION');
  });
});

describe('parseUploadResponse', () => {
  it('returns the parsed 2xx body', () => {
    expect(parseUploadResponse(201, JSON.stringify({ attachment }), AttachmentResponse)).toEqual({
      attachment,
    });
  });

  it('rejects a 2xx body that fails the schema', () => {
    const err = catchApiError(() => parseUploadResponse(201, '{"attachment":{}}', AttachmentResponse));
    expect(err.code).toBe('INTERNAL');
  });
});

/** A minimal XMLHttpRequest double that records the request and answers on `send`. */
class FakeXhr {
  static last: FakeXhr | null = null;
  static respond: (xhr: FakeXhr) => void = () => undefined;

  method = '';
  url = '';
  headers: Record<string, string> = {};
  body: unknown = null;
  status = 0;
  responseText = '';
  responseType = '';
  upload = new EventTarget();
  private events = new EventTarget();

  constructor() {
    FakeXhr.last = this;
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  addEventListener(type: string, listener: () => void) {
    this.events.addEventListener(type, listener);
  }
  send(body: unknown) {
    this.body = body;
    FakeXhr.respond(this);
  }
  abort() {
    this.fire('abort');
  }
  fire(type: string) {
    this.events.dispatchEvent(new Event(type));
  }
}

describe('uploadAttachment', () => {
  it('posts one multipart part named file with the CSRF header and no manual Content-Type', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    FakeXhr.respond = (xhr) => {
      xhr.status = 201;
      xhr.responseText = JSON.stringify({ attachment });
      xhr.fire('load');
    };
    const file = new File(['%PDF-1.4'], 'report.pdf', { type: 'application/pdf' });
    await expect(uploadAttachment(file)).resolves.toEqual(attachment);

    const xhr = FakeXhr.last;
    expect(xhr?.method).toBe('POST');
    expect(xhr?.url).toBe('/api/attachments');
    expect(xhr?.headers[CSRF_HEADER]).toBe(CSRF_HEADER_VALUE);
    expect(Object.keys(xhr?.headers ?? {}).map((h) => h.toLowerCase())).not.toContain('content-type');
    const body = xhr?.body;
    if (!(body instanceof FormData)) throw new Error('expected FormData');
    expect([...body.keys()]).toEqual(['file']);
    const part = body.get('file');
    expect(part instanceof File ? part.name : null).toBe('report.pdf');
  });

  it("maps the proxy's HTML 413 to PAYLOAD_TOO_LARGE", async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    FakeXhr.respond = (xhr) => {
      xhr.status = 413;
      xhr.responseText = CADDY_413;
      xhr.fire('load');
    };
    const err = await rejectsApiError(uploadAttachment(new File(['x'], 'big.bin')));
    expect(err.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('reports a network failure as status 0', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    FakeXhr.respond = (xhr) => {
      xhr.fire('error');
    };
    const err = await rejectsApiError(uploadAttachment(new File(['x'], 'a.txt')));
    expect(err.status).toBe(0);
  });

  it('rejects with an AbortError when cancelled', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    FakeXhr.respond = () => undefined; // never answers
    const controller = new AbortController();
    const upload = uploadAttachment(new File(['x'], 'a.txt'), { signal: controller.signal });
    controller.abort();
    await expect(upload).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('deleteAttachment (row 28b)', () => {
  it('sends DELETE /api/attachments/:id with the CSRF header and no body', async () => {
    const fetchMock = vi.fn((_url: string, _init: RequestInit) =>
      Promise.resolve(new Response(null, { status: 204 })),
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(deleteAttachment(attachment.id)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(`/api/attachments/${attachment.id}`);
    expect(init?.method).toBe('DELETE');
    expect(init?.body).toBeUndefined();
    expect(new Headers(init?.headers).get(CSRF_HEADER)).toBe(CSRF_HEADER_VALUE);
  });

  it('rejects with NOT_FOUND once the upload was sent or is gone', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(new Response(errorBody('NOT_FOUND', 'Attachment not found'), { status: 404 })),
      ),
    );
    expect((await rejectsApiError(deleteAttachment(attachment.id))).code).toBe('NOT_FOUND');
  });
});
