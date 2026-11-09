import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";

// These tests use the public PeerJS signaling broker, so they need internet access.
test.beforeAll(async ({ request }) => {
  const ok = await request.get("https://0.peerjs.com/peerjs/id", { timeout: 8000 }).then((r) => r.ok(), () => false);
  test.skip(!ok, "PeerJS broker unreachable");
});

const FILE_BYTES = 3 * 1024 * 1024; // 48 chunks

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
    let done = false;
    const orig = Uint8Array.prototype.set;
    Uint8Array.prototype.set = function (src: ArrayLike<number>, off?: number) {
      orig.call(this, src, off);
      if (!done && src.length === 65536 && this.length === 65536) {
        done = true;
        this[100] ^= 0xff;
      }
    };
  });
  await expect(guest.getByText(/failed verification/i).first()).toBeVisible({ timeout: 60_000 });
  await expect(guest.getByText(/asking the host to re-send/i).first()).toBeVisible({ timeout: 30_000 });
  await expect(guest.getByText(/integrity check passed/i).first()).toBeVisible({ timeout: 60_000 });
});

test("the worker-based file writer completes a transfer", async ({ context }) => {
  const { guest } = await setup(context, () => localStorage.setItem("syncplayer:forceopfsworker", "true"));
  await expect(guest.getByText(/worker-based file writer/i).first()).toBeVisible({ timeout: 60_000 });
  await expect(guest.getByText(/integrity check passed/i).first()).toBeVisible({ timeout: 60_000 });
});

test("a viewer vanishing mid-transfer releases the host's upload lock", async ({ context }) => {
  const host = await context.newPage();
  const guest = await context.newPage();
  const code = await startHost(host);
  await join(guest, code);
  await expect(guest.getByText(/live session synchronized/i)).toBeVisible({ timeout: 30_000 });
  // Playwright caps in-memory uploads at 50 MB, so a file this large goes in by path.
  const bigPath = joinPath(mkdtempSync(joinPath(tmpdir(), "syncplayer-e2e-")), "big.mp4");
  writeFileSync(bigPath, Buffer.alloc(200 * 1024 * 1024, 3));
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
  const bigPath = joinPath(mkdtempSync(joinPath(tmpdir(), "syncplayer-e2e-")), "big.mp4");
  writeFileSync(bigPath, Buffer.alloc(200 * 1024 * 1024, 3));
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
