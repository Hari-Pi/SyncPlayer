import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";

// These tests use the public PeerJS signaling broker, so they need internet access.
test.beforeAll(async ({ request }) => {
  const ok = await request.get("https://0.peerjs.com/peerjs/id", { timeout: 8000 }).then((r) => r.ok(), () => false);
  test.skip(!ok, "PeerJS broker unreachable");
});

const FILE_BYTES = 3 * 1024 * 1024; // 48 chunks

// Large files go through disk (Playwright caps in-memory uploads at 50 MB); remove them afterwards.
const tempDirs: string[] = [];
function bigFile(bytes: number) {
  const dir = mkdtempSync(joinPath(tmpdir(), "syncplayer-e2e-"));
  tempDirs.push(dir);
  const path = joinPath(dir, "big.mp4");
  writeFileSync(path, Buffer.alloc(bytes, 3));
  return path;
}
test.afterAll(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function startHost(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: /start room/i }).click();
  const code = (await page.locator(".room-code-digits").innerText({ timeout: 20_000 })).trim();
  await page.getByText(/allow all connections/i).click(); // auto-accept viewers
  return code;
}

async function join(page: Page, code: string) {
  await page.goto("/");
  await page.locator("input[maxlength='4']").fill(code);
  await page.getByRole("button", { name: /^join$/i }).click();
}

async function setup(context: BrowserContext, guestInit?: () => void) {
  const host = await context.newPage();
  const guest = await context.newPage();
  if (guestInit) await guest.addInitScript(guestInit);
  const code = await startHost(host);
  await join(guest, code);
  // Share a file once the viewer is connected; the host streams it to them.
  await expect(guest.getByText(/live session synchronized/i)).toBeVisible({ timeout: 30_000 });
  await host.locator("input[type=file]").setInputFiles({
    name: "clip.mp4",
    mimeType: "video/mp4",
    buffer: Buffer.alloc(FILE_BYTES, 7)
  });
  return { host, guest };
}

test("guest receives a file and the integrity check passes", async ({ context }) => {
  const { host, guest } = await setup(context);
  await expect(guest.getByText(/integrity check passed/i).first()).toBeVisible({ timeout: 60_000 });
  await expect(host.getByText(/fully sent/i).first()).toBeVisible();
});

test("a corrupted chunk is discarded and re-requested", async ({ context }) => {
  const { guest } = await setup(context, () => {
    // The receiver copies each chunk with slice() before handing it to the writer worker,
    // which verifies it: flip a byte in the first full-size copy.
    let done = false;
    const orig = Uint8Array.prototype.slice;
    Uint8Array.prototype.slice = function (this: Uint8Array, ...args: [number?, number?]) {
      const copy = orig.apply(this, args) as Uint8Array;
      if (!done && args.length === 0 && copy.length === 65536) {
        done = true;
        copy[100] ^= 0xff;
      }
      return copy;
    } as typeof Uint8Array.prototype.slice;
  });
  await expect(guest.getByText(/failed verification/i).first()).toBeVisible({ timeout: 60_000 });
  await expect(guest.getByText(/asking the host to re-send/i).first()).toBeVisible({ timeout: 30_000 });
  await expect(guest.getByText(/integrity check passed/i).first()).toBeVisible({ timeout: 60_000 });
});

test("the main-thread fallback file writer completes a transfer", async ({ context }) => {
  const { guest } = await setup(context, () => localStorage.setItem("syncplayer:forcestreamwriter", "true"));
  await expect(guest.getByText(/main-thread file writer/i).first()).toBeVisible({ timeout: 60_000 });
  await expect(guest.getByText(/integrity check passed/i).first()).toBeVisible({ timeout: 60_000 });
});

test("a viewer vanishing mid-transfer releases the host's upload lock", async ({ context }) => {
  const host = await context.newPage();
  const guest = await context.newPage();
  const code = await startHost(host);
  await join(guest, code);
  await expect(guest.getByText(/live session synchronized/i)).toBeVisible({ timeout: 30_000 });
  const bigPath = bigFile(200 * 1024 * 1024);
  await host.locator("input[type=file]").setInputFiles(bigPath);
  await expect(guest.getByText(/receiving/i).first()).toBeVisible({ timeout: 30_000 });
  await guest.close();
  await expect(host.getByText(/stopped sending|could not be delivered/i).first()).toBeVisible({ timeout: 60_000 });
  await expect(host.getByText(/playback is locked/i)).toHaveCount(0, { timeout: 10_000 });
});

test("the host can start playback anyway while an upload continues", async ({ context }) => {
  const host = await context.newPage();
  const guest = await context.newPage();
  const code = await startHost(host);
  await join(guest, code);
  await expect(guest.getByText(/live session synchronized/i)).toBeVisible({ timeout: 30_000 });
  const bigPath = bigFile(200 * 1024 * 1024);
  await host.locator("input[type=file]").setInputFiles(bigPath);
  await expect(host.getByText(/playback is locked/i)).toBeVisible({ timeout: 30_000 });
  await host.getByRole("button", { name: /start playback anyway/i }).click();
  await expect(host.getByText(/playback is locked/i)).toHaveCount(0);
  await expect(guest.getByText(/integrity check passed/i).first()).toBeVisible({ timeout: 90_000 });
});

test("an unplayable file shows a banner instead of a broken player", async ({ context }) => {
  const { guest } = await setup(context);
  await expect(guest.getByText(/can't play "clip\.mp4"/i)).toBeVisible({ timeout: 60_000 });
  await expect(guest.getByRole("button", { name: /show player anyway/i })).toBeVisible();
});

test("the guest follows the host's playback of a WebM with unknown duration", async ({ context }) => {
  const host = await context.newPage();
  const guest = await context.newPage();
  const code = await startHost(host);
  await join(guest, code);
  await expect(guest.getByText(/live session synchronized/i)).toBeVisible({ timeout: 30_000 });

  // MediaRecorder WebM reports duration = Infinity — the case that used to break every sync message.
  await host.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 160;
    canvas.height = 90;
    const g = canvas.getContext("2d")!;
    let frame = 0;
    const timer = setInterval(() => {
      g.fillStyle = `hsl(${(frame++ * 9) % 360},70%,50%)`;
      g.fillRect(0, 0, 160, 90);
    }, 33);
    const recorder = new MediaRecorder(canvas.captureStream(30), { mimeType: "video/webm" });
    const parts: Blob[] = [];
    recorder.ondataavailable = (e) => parts.push(e.data);
    recorder.start(500);
    await new Promise((r) => setTimeout(r, 10_000));
    recorder.stop();
    await new Promise((r) => (recorder.onstop = r));
    clearInterval(timer);
    const transfer = new DataTransfer();
    transfer.items.add(new File(parts, "rec.webm", { type: "video/webm" }));
    const input = document.querySelector<HTMLInputElement>("input[type=file]")!;
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect(guest.getByText(/integrity check passed/i).first()).toBeVisible({ timeout: 60_000 });

  const video = (page: typeof host) => page.locator(".artplayer-container video");
  const state = (page: typeof host) =>
    video(page).evaluate((v: HTMLVideoElement) => ({ t: v.currentTime, paused: v.paused }));

  // Play on the host: the guest starts playing and stays close.
  await video(host).evaluate(async (v: HTMLVideoElement) => {
    v.muted = true;
    await v.play();
  });
  await expect.poll(async () => (await state(guest)).paused, { timeout: 15_000 }).toBe(false);
  await host.waitForTimeout(2000);
  const [h1, g1] = await Promise.all([state(host), state(guest)]);
  expect(Math.abs(h1.t - g1.t)).toBeLessThan(0.6);

  // Seek + pause on the host: the guest lands on the same frame.
  await video(host).evaluate((v: HTMLVideoElement) => {
    v.pause();
    v.currentTime = 4;
  });
  await expect.poll(async () => (await state(guest)).paused, { timeout: 15_000 }).toBe(true);
  await expect.poll(async () => Math.abs((await state(guest)).t - 4), { timeout: 15_000 }).toBeLessThan(0.1);
});
