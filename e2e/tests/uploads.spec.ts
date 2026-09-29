import { randomUUID } from 'node:crypto';
import type { APIRequestContext, APIResponse, Locator, Page } from '@playwright/test';
import type { ApiErrorBody, UserResponse } from '@hearth/shared';
import {
  api,
  createChannel,
  escapeRegExp,
  expect,
  expectConnected,
  findStoredFile,
  gotoChannel,
  maxSizeFile,
  NEEDS_TEST_MODE,
  openDm,
  oversizeFile,
  sendMessage,
  test,
  textFile,
  tinyGif,
  tinyPdf,
  tinyPng,
  UPLOAD_MAX_BYTES,
  uploadAttachment,
  uploadAttachmentOk,
  type FilePayload,
  type TestUser,
} from '../fixtures.js';
import { isFullStack } from '../env.js';

// Selectors: docs/plans/phase-5.md "Web UI contract" (plus phase-3's message/composer selectors).
// Serving rules: CONTRACTS B.7a (rows 27, 28, 10, 11, 14).

const TOO_LARGE_ALERT = 'File is too large (max 25 MB).';
const AVATAR_TYPE_ALERT = 'Avatar must be a PNG, JPEG or WebP image.';
const AVATAR_UPDATED = 'Avatar updated.';
const AVATAR_REMOVED = 'Avatar removed.';
const ATTACHMENTS_ROUTE = '**/api/attachments';

function composer(page: Page): Locator {
  return page.getByRole('textbox', { name: 'Message', exact: true });
}

function button(scope: Page | Locator, name: string): Locator {
  return scope.getByRole('button', { name, exact: true });
}

function attachInput(page: Page): Locator {
  return page.getByLabel('Attach files', { exact: true });
}

function chips(page: Page): Locator {
  return page.getByTestId('attachment-chip');
}

function chip(page: Page, filename: string): Locator {
  return chips(page).filter({ hasText: filename });
}

function alertWith(page: Page, text: string): Locator {
  return page.getByRole('alert').filter({ hasText: text });
}

function statusWith(page: Page, text: string): Locator {
  return page.getByRole('status').filter({ hasText: text });
}

function messageById(page: Page, id: string): Locator {
  return page.locator(`[data-testid="message-item"][data-message-id="${id}"]`);
}

/** The `message-item` whose `message-content` is exactly `text`. */
function messageByText(page: Page, text: string): Locator {
  return page.getByTestId('message-item').filter({
    has: page.getByTestId('message-content').getByText(text, { exact: true }),
  });
}

function memberItem(page: Page, displayName: string): Locator {
  return page.getByTestId('member-item').filter({ hasText: displayName });
}

/** `a[data-testid="attachment-file"]` whose text is `<filename> (<size>)`. */
function fileLink(scope: Locator, filename: string): Locator {
  return scope
    .getByTestId('attachment-file')
    .filter({ hasText: new RegExp(`^${escapeRegExp(filename)} \\(.+\\)$`) });
}

/** Loads the app, waits for a live socket and opens `#name`. */
async function openChannel(user: TestUser, name: string): Promise<void> {
  await user.page.goto('/');
  await expectConnected(user.page);
  await gotoChannel(user.page, name);
}

async function hrefOf(link: Locator): Promise<string> {
  const href = await link.getAttribute('href');
  if (href === null) throw new Error('link has no href');
  return href;
}

/** `naturalWidth` of an `img` (0 until it has loaded and decoded). e2e has no DOM lib. */
async function naturalWidth(img: Locator): Promise<number> {
  return img.evaluate((el: unknown) => (el as { naturalWidth: number }).naturalWidth);
}

/** Attaches `files` through the composer's **Attach files** input and waits for every chip to be `ready`. */
async function attachReady(page: Page, files: FilePayload[]): Promise<void> {
  await attachInput(page).setInputFiles(files);
  for (const file of files) {
    await expect(chip(page, file.name)).toHaveAttribute('data-state', 'ready');
  }
}

/** Types `text`, clicks **Send** and waits for the confirmed item and the cleared chips. */
async function sendWithText(page: Page, text: string): Promise<void> {
  await composer(page).fill(text);
  const send = button(page, 'Send');
  await expect(send).toBeEnabled();
  await send.click();
  const item = messageByText(page, text);
  await expect(item).toBeVisible();
  await expect(item).not.toHaveAttribute('data-pending', 'true');
  await expect(chips(page)).toHaveCount(0);
}

function mediaType(res: APIResponse): string {
  return (res.headers()['content-type'] ?? '').split(';')[0]?.trim() ?? '';
}

/** GETs a file URL (row 28), expects 200 and the headers every file response carries (B.7a). */
async function fetchFile(request: APIRequestContext, url: string): Promise<APIResponse> {
  const res = await request.get(url);
  expect(res.status(), `GET ${url}`).toBe(200);
  const headers = res.headers();
  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(headers['content-security-policy']).toContain('sandbox');
  return res;
}

async function expectErrorStatus(
  request: APIRequestContext,
  url: string,
  status: number,
  code: ApiErrorBody['error']['code'],
): Promise<void> {
  const res = await api(request).get<ApiErrorBody>(url);
  expect(res.status, `GET ${url}`).toBe(status);
  expect(res.body.error.code).toBe(code);
}

test.describe('uploads', { tag: '@uploads' }, () => {
  test.skip(isFullStack, NEEDS_TEST_MODE);

  test('1. A attaches a PNG and a PDF; B sees an inline image and a download link; headers are right', async ({
    users,
  }) => {
    const { alice, bob } = await users(['alice', 'bob']);
    await createChannel(alice.request, { name: 'general', type: 'text' });
    await openChannel(alice, 'general');
    await openChannel(bob, 'general');

    const png = tinyPng('pixel.png');
    const pdf = tinyPdf('report.pdf');

    // Hold the uploads so the in-flight state is observable, then let them through.
    const { promise: held, resolve: release } = Promise.withResolvers<undefined>();
    await alice.page.route(ATTACHMENTS_ROUTE, async (route) => {
      await held;
      await route.continue();
    });
    await attachInput(alice.page).setInputFiles([png, pdf]);
    await expect(chip(alice.page, png.name)).toHaveAttribute('data-state', 'uploading');
    await expect(button(alice.page, 'Send')).toBeDisabled();
    release(undefined);
    await expect(chip(alice.page, png.name)).toHaveAttribute('data-state', 'ready');
    await expect(chip(alice.page, pdf.name)).toHaveAttribute('data-state', 'ready');
    await alice.page.unroute(ATTACHMENTS_ROUTE);
    await expect(button(chip(alice.page, png.name), `Remove ${png.name}`)).toBeVisible();

    const text = 'files for you';
    await sendWithText(alice.page, text);

    // B: the PNG renders inline, wrapped in a new-tab link to the file.
    const bobItem = messageByText(bob.page, text);
    const image = bobItem.getByTestId('attachment-image');
    await expect(image).toHaveCount(1);
    await expect(image).toHaveAttribute('alt', png.name);
    await image.scrollIntoViewIfNeeded();
    await expect.poll(() => naturalWidth(image)).toBeGreaterThan(0);
    // `has` locators are resolved relative to each candidate link, so start from the page, not bobItem.
    const imageLink = bobItem.getByRole('link').filter({ has: bob.page.getByTestId('attachment-image') });
    await expect(imageLink).toHaveAttribute('target', '_blank');
    const pngUrl = await hrefOf(imageLink);
    expect(pngUrl).toMatch(/\/api\/attachments\/[0-9a-f-]{36}\/pixel\.png$/);

    // B: the PDF is a download link "<name> (<size>)", never an image.
    const pdfLink = fileLink(bobItem, pdf.name);
    await expect(pdfLink).toHaveCount(1);
    await expect(pdfLink).toHaveAttribute('download');
    const pdfUrl = await hrefOf(pdfLink);
    expect(pdfUrl).toMatch(/\/api\/attachments\/[0-9a-f-]{36}\/report\.pdf$/);
    await expect(bobItem.getByTestId('attachment-file')).toHaveCount(1);

    const pngRes = await fetchFile(bob.request, pngUrl);
    expect(mediaType(pngRes)).toBe('image/png');
    expect(pngRes.headers()['content-disposition']).toMatch(/^inline;/);
    expect((await pngRes.body()).equals(png.buffer)).toBe(true);

    const pdfRes = await fetchFile(bob.request, pdfUrl);
    // Non-inline files are always served as octet-stream (B.7a); the DTO keeps the sniffed application/pdf.
    expect(mediaType(pdfRes)).toBe('application/octet-stream');
    const disposition = pdfRes.headers()['content-disposition'] ?? '';
    expect(disposition).toMatch(/^attachment;/);
    expect(disposition).toContain('filename="report.pdf"');
    expect(disposition).toContain("filename*=UTF-8''report.pdf");
    expect((await pdfRes.body()).equals(pdf.buffer)).toBe(true);
  });

  test('2. a 26 MB file is refused: UI alert without a chip or request, API 413 PAYLOAD_TOO_LARGE', async ({
    users,
  }) => {
    const { alice } = await users(['alice']);
    await createChannel(alice.request, { name: 'general', type: 'text' });
    await openChannel(alice, 'general');

    const uploads: string[] = [];
    alice.page.on('request', (req) => {
      if (req.method() === 'POST' && new URL(req.url()).pathname === '/api/attachments') {
        uploads.push(req.url());
      }
    });

    await attachInput(alice.page).setInputFiles(oversizeFile('huge.bin'));
    await expect(alertWith(alice.page, TOO_LARGE_ALERT)).toBeVisible();
    await expect(chips(alice.page)).toHaveCount(0);

    // Positive control: a small file right after does upload, and it is the only request seen
    // (the oversize one would have been issued first).
    const png = tinyPng('small.png');
    await attachReady(alice.page, [png]);
    await expect(chips(alice.page)).toHaveCount(1);
    expect(uploads).toHaveLength(1);

    const res = await uploadAttachment<ApiErrorBody>(alice.request, oversizeFile('huge.bin'));
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  test('2b. a file of exactly the 25 MiB cap uploads through the proxy (201)', async ({ users }) => {
    const { alice } = await users(['alice']);
    const general = await createChannel(alice.request, { name: 'general', type: 'text' });
    const file = maxSizeFile('exactly-25mib.bin');
    const attachment = await uploadAttachmentOk(alice.request, file);
    expect(attachment.sizeBytes).toBe(UPLOAD_MAX_BYTES);
    expect(attachment.filename).toBe('exactly-25mib.bin');

    // Clean up the 25 MiB on disk: sending then deleting the message unlinks the file (B.7).
    const message = await sendMessage(alice.request, general.id, 'max size', [attachment.id]);
    expect((await api(alice.request).delete(`/api/messages/${message.id}`)).status).toBe(204);
  });

  test('3. access: anonymous 401; a DM file is 404 for a non-member; an unattached upload is 404 for others', async ({
    users,
    request,
  }) => {
    const { alice, bob, carol } = await users(['alice', 'bob', 'carol']);
    const dm = await openDm(alice.request, bob.id);
    const shared = await uploadAttachmentOk(alice.request, tinyPng('secret.png'));
    const message = await sendMessage(alice.request, dm.id, 'for your eyes only', [shared.id]);
    expect(message.attachments.map((a) => a.id)).toEqual([shared.id]);
    const draft = await uploadAttachmentOk(alice.request, tinyPdf('draft.pdf'));

    // Positive controls: both DM members can read the sent file; the uploader can read her draft.
    await fetchFile(alice.request, shared.url);
    await fetchFile(bob.request, shared.url);
    await fetchFile(alice.request, draft.url);
    // The `:filename` segment is cosmetic.
    await fetchFile(bob.request, shared.url.replace(/[^/]+$/, 'renamed.png'));

    // `request` is the anonymous fixture context (no cookies).
    await expectErrorStatus(request, shared.url, 401, 'UNAUTHENTICATED');
    await expectErrorStatus(request, draft.url, 401, 'UNAUTHENTICATED');
    await expectErrorStatus(carol.request, shared.url, 404, 'NOT_FOUND');
    await expectErrorStatus(bob.request, draft.url, 404, 'NOT_FOUND');
    await expectErrorStatus(carol.request, draft.url, 404, 'NOT_FOUND');
  });

  test('4. SVG and HTML are never images: download links served as attachment octet-stream', async ({
    users,
  }) => {
    const { alice, bob } = await users(['alice', 'bob']);
    await createChannel(alice.request, { name: 'general', type: 'text' });
    await openChannel(alice, 'general');
    await openChannel(bob, 'general');

    // file-type detects neither, so they fall back to application/octet-stream (B.7a).
    const svg = textFile(
      'evil.svg',
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script></svg>',
      'image/svg+xml',
    );
    const html = textFile(
      'evil.html',
      '<!doctype html><html><body><script>alert(1)</script></body></html>',
      'text/html',
    );
    // With an XML prolog file-type sniffs application/xml; it must still be served as an octet-stream download.
    const xmlSvg = textFile(
      'evil-xml.svg',
      '<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>',
      'image/svg+xml',
    );

    await attachReady(alice.page, [svg, html, xmlSvg]);
    const text = 'totally harmless files';
    await sendWithText(alice.page, text);

    const bobItem = messageByText(bob.page, text);
    await expect(bobItem.getByTestId('attachment-file')).toHaveCount(3);
    await expect(bobItem.getByTestId('attachment-image')).toHaveCount(0);
    await expect(bobItem.locator('img:not([data-testid="avatar"]), iframe, object, embed')).toHaveCount(0);

    for (const file of [svg, html, xmlSvg]) {
      const link = fileLink(bobItem, file.name);
      await expect(link).toHaveCount(1);
      await expect(link).toHaveAttribute('download');
      const res = await fetchFile(bob.request, await hrefOf(link));
      expect(res.headers()['content-disposition'], file.name).toMatch(/^attachment;/);
      // Whatever was sniffed (nothing, or application/xml for the prolog SVG), it's served as octet-stream (B.7a).
      expect(mediaType(res), file.name).toBe('application/octet-stream');
    }
  });

  test('5. B sets and removes an avatar in Settings; A sees it change live; a GIF is refused', async ({
    users,
  }) => {
    const { alice, bob } = await users(['alice', 'bob']);
    const general = await createChannel(alice.request, { name: 'general', type: 'text' });
    const bobMessage = await sendMessage(bob.request, general.id, 'hi from bob');
    await openChannel(alice, 'general');

    const bobMember = memberItem(alice.page, bob.displayName);
    const bobItem = messageById(alice.page, bobMessage.id);
    const avatarSpots = [bobMember, bobItem];
    for (const spot of avatarSpots) {
      await expect(spot.locator('span[data-testid="avatar"]')).toHaveText(/^b/i);
      await expect(spot.locator('img[data-testid="avatar"]')).toHaveCount(0);
    }

    await bob.page.goto('/settings');
    const avatarInput = bob.page.getByLabel('Avatar', { exact: true });
    await expect(button(bob.page, 'Remove avatar')).toHaveCount(0);

    await avatarInput.setInputFiles(tinyPng('me.png'));
    await expect(statusWith(bob.page, AVATAR_UPDATED)).toBeVisible();
    const me = await api(bob.request).get<UserResponse>('/api/me');
    const avatarUrl = me.body.user.avatarUrl ?? '';
    expect(avatarUrl).toMatch(new RegExp(`^/api/avatars/${bob.id}\\?v=[0-9a-f]{8}$`));

    // A: no reload; the member list and B's message both switch to the image.
    for (const spot of avatarSpots) {
      const img = spot.locator('img[data-testid="avatar"]');
      await expect(img).toHaveAttribute('src', new RegExp(`${escapeRegExp(avatarUrl)}$`));
      await expect(spot.locator('span[data-testid="avatar"]')).toHaveCount(0);
      await img.scrollIntoViewIfNeeded();
      await expect.poll(() => naturalWidth(img)).toBeGreaterThan(0);
    }

    await button(bob.page, 'Remove avatar').click();
    await expect(statusWith(bob.page, AVATAR_REMOVED)).toBeVisible();
    await expect(button(bob.page, 'Remove avatar')).toHaveCount(0);
    for (const spot of avatarSpots) {
      await expect(spot.locator('img[data-testid="avatar"]')).toHaveCount(0);
      await expect(spot.locator('span[data-testid="avatar"]')).toHaveText(/^b/i);
    }

    await avatarInput.setInputFiles(tinyGif('anim.gif'));
    await expect(alertWith(bob.page, AVATAR_TYPE_ALERT)).toBeVisible();
    expect((await api(bob.request).get<UserResponse>('/api/me')).body.user.avatarUrl).toBeNull();
    await expect(bobMember.locator('span[data-testid="avatar"]')).toHaveText(/^b/i);
  });

  test('6. deleting a message with an attachment makes its file URL 404 and unlinks the file', async ({
    users,
  }) => {
    const { alice, bob } = await users(['alice', 'bob']);
    const general = await createChannel(alice.request, { name: 'general', type: 'text' });
    // Unique bytes, so the stored copy can be found on disk.
    const note = textFile('note.txt', `short-lived note ${randomUUID()}\n`);
    const attachment = await uploadAttachmentOk(alice.request, note);
    expect(await findStoredFile(note.buffer)).toMatch(/^\d{4}\/\d{2}\/[0-9a-f-]{36}$/);
    const message = await sendMessage(alice.request, general.id, 'this will not last', [attachment.id]);

    await openChannel(bob, 'general');
    const bobItem = messageById(bob.page, message.id);
    await expect(fileLink(bobItem, note.name)).toHaveCount(1);
    await fetchFile(bob.request, attachment.url);

    expect((await api(alice.request).delete(`/api/messages/${message.id}`)).status).toBe(204);
    await expect(bobItem).toHaveCount(0);
    await expectErrorStatus(bob.request, attachment.url, 404, 'NOT_FOUND');
    await expectErrorStatus(alice.request, attachment.url, 404, 'NOT_FOUND');
    // Unlinked after commit (B.7), so it may trail the 204 slightly.
    await expect.poll(() => findStoredFile(note.buffer)).toBeNull();
  });
});
