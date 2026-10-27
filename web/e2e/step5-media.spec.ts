// Voice and scanned documents (features 7 and 25) in a real browser, against the real API and the AI service as CI runs
// it: with no media reader switched on (MEDIA_READER unset = none), a recording and a photo of a page are accepted by
// the screen and the API, sent to the AI service, refused there, and the reason is shown in plain words. Nothing is
// kept. (Reading them with the test stand-in is proven in services/ai/tests/integration/test_media_upload.py.)
// Runs last (files in name order), so the failed documents it leaves cannot change what earlier files see.
import { expect, test } from '@playwright/test';
import { checkScreen, keepPageTextOnFailure, signIn } from './support.ts';

test.afterEach(async ({ page }, info) => keepPageTextOnFailure(page, info));

const WAV = Buffer.concat([Buffer.from('RIFF\u0000\u0000\u0000\u0000WAVEfmt ', 'latin1'), Buffer.alloc(64)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);

test('a recording and a photo of a page are refused with the reason while no reader is switched on', async ({ page }) => {
  await signIn(page, 'owner');
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Documents', exact: true }).click();
  for (const [title, file, reason] of [
    ['Walk-through recording (synthetic)', { name: 'walk-through.wav', mimeType: 'audio/wav', buffer: WAV }, /no speech-to-text service is switched on/],
    ['Photo of a checklist (synthetic)', { name: 'checklist.png', mimeType: 'image/png', buffer: PNG }, /no text-recognition service is switched on/],
  ] as const) {
    await page.getByLabel('Title').fill(title);
    await page.getByLabel('File').setInputFiles(file);
    await page.getByRole('button', { name: 'Add document' }).click();
    await expect(page.getByText('The document could not be used')).toBeVisible();
    await expect(page.getByText(reason)).toBeVisible();
    if (title.startsWith('Walk')) await checkScreen(page, '70-recording-refused');
    await page.getByRole('button', { name: 'Add another' }).click();
  }
});
