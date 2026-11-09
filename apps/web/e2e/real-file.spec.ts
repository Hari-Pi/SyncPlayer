import { expect, test } from "@playwright/test";

// Optional: sync check against a real video. Run with SYNC_VIDEO=/path/to/file pnpm test:e2e
const file = process.env.SYNC_VIDEO;
test.skip(!file, "set SYNC_VIDEO to a video file to run");

test("guest follows host playback of a real video file", async ({ context }) => {
  test.setTimeout(240_000);
  const host = await context.newPage();
  const guest = await context.newPage();
  await host.goto("/");
  await host.getByRole("button", { name: /start room/i }).click();
  const code = (await host.locator(".room-code-digits").innerText({ timeout: 20_000 })).trim();
  await host.getByText(/allow all connections/i).click();
  await guest.goto("/");
  await guest.locator("input[maxlength='4']").fill(code);
  await guest.getByRole("button", { name: /^join$/i }).click();
  await expect(guest.getByText(/live session synchronized/i)).toBeVisible({ timeout: 30_000 });

  await host.locator("input[type=file]").setInputFiles(file!);
  await expect(guest.getByText(/integrity check passed/i).first()).toBeVisible({ timeout: 180_000 });
  await expect(guest.getByText(/can't play/i)).toHaveCount(0);

  const video = (p: typeof host) => p.locator(".artplayer-container video");
  const state = (p: typeof host) => video(p).evaluate((v: HTMLVideoElement) => ({ t: v.currentTime, paused: v.paused, d: v.duration }));
  await video(host).evaluate(async (v: HTMLVideoElement) => { v.muted = true; await v.play(); });
  await expect.poll(async () => (await state(guest)).paused, { timeout: 15_000 }).toBe(false);
  await host.waitForTimeout(4000);
  const [h, g] = await Promise.all([state(host), state(guest)]);
  console.log("playing", h, g);
  expect(Math.abs(h.t - g.t)).toBeLessThan(0.6);

  await video(host).evaluate((v: HTMLVideoElement) => { v.currentTime = 60; });
  await host.waitForTimeout(4000);
  const [h2, g2] = await Promise.all([state(host), state(guest)]);
  console.log("after seek", h2, g2);
  expect(Math.abs(h2.t - g2.t)).toBeLessThan(0.6);

  await video(host).evaluate((v: HTMLVideoElement) => v.pause());
  await expect.poll(async () => (await state(guest)).paused, { timeout: 15_000 }).toBe(true);
  await expect.poll(async () => Math.abs((await state(guest)).t - (await state(host)).t), { timeout: 15_000 }).toBeLessThan(0.1);
});
