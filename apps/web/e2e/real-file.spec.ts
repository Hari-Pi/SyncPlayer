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

  // Sample the guest's player area every 50 ms: from the first chunk until the player is ready,
  // it must always show either the chunk view (receiving or processing) or a loaded player.
  await guest.evaluate(() => {
    const w = window as unknown as { __samples: Array<{ at: number; view: string; ready: boolean }> };
    w.__samples = [];
    setInterval(() => {
      const view = document.querySelector(".chunk-transfer")?.textContent ?? "";
      const video = document.querySelector<HTMLVideoElement>(".artplayer-container video");
      w.__samples.push({ at: performance.now(), view, ready: !!video && video.readyState >= 1 });
    }, 50);
  });
  await host.locator("input[type=file]").setInputFiles(file!);
  await expect(guest.getByText(/integrity check passed/i).first()).toBeVisible({ timeout: 180_000 });
  await expect.poll(() => guest.locator(".artplayer-container video").evaluate((v: HTMLVideoElement) => v.readyState), { timeout: 60_000 }).toBeGreaterThan(0);

  const samples = await guest.evaluate(() => (window as unknown as { __samples: Array<{ at: number; view: string; ready: boolean }> }).__samples);
  const firstView = samples.findIndex((x) => x.view);
  const firstReady = samples.findIndex((x) => x.ready);
  const gap = samples.slice(firstView, firstReady).filter((x) => !x.view);
  const stages = new Map<string, number>();
  for (const x of samples.slice(firstView, firstReady)) {
    const stage = /processing/i.test(x.view) ? x.view.replace(/.*"[^"]*"/, "").split(/\d/)[0].trim() : "receiving";
    stages.set(stage, (stages.get(stage) ?? 0) + 50);
  }
  console.log("stages (ms):", Object.fromEntries(stages), "blank samples:", gap.length);
  expect(gap.length).toBe(0);
  await expect(guest.getByText(/can't play/i)).toHaveCount(0);

  const video = (p: typeof host) => p.locator(".artplayer-container video");
  const state = (p: typeof host) => video(p).evaluate((v: HTMLVideoElement) => ({ t: v.currentTime, paused: v.paused, d: v.duration }));
  await video(host).evaluate(async (v: HTMLVideoElement) => { v.muted = true; await v.play(); });
  await expect.poll(async () => (await state(guest)).paused, { timeout: 15_000 }).toBe(false);
  await host.waitForTimeout(4000);
  const [h, g] = await Promise.all([state(host), state(guest)]);
  console.log("playing", h, g);
  expect(Math.abs(h.t - g.t)).toBeLessThan(0.6);

  // Simulate a slower receiver (e.g. a phone): seeks take longer to decode/rebuffer, which is
  // what used to cause a catch-up loop (seek -> spinner -> host moved on -> seek again).
  // Measured inside the guest page (its own drift reading), since cross-page timing is skewed
  // when one page is throttled.
  const cdp = await context.newCDPSession(guest);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: Number(process.env.SYNC_THROTTLE ?? 6) });
  await guest.evaluate(() => {
    const w = window as unknown as { __seeks: number; __modes: string[] };
    w.__seeks = 0;
    w.__modes = [];
    document.querySelector(".artplayer-container video")!.addEventListener("seeking", () => w.__seeks++);
    setInterval(() => w.__modes.push(document.querySelector(".status-pill")?.textContent ?? ""), 250);
  });
  await video(host).evaluate((v: HTMLVideoElement) => { v.currentTime = 60; });
  await host.waitForTimeout(15_000);
  const { seeks, modes } = await guest.evaluate(() => {
    const w = window as unknown as { __seeks: number; __modes: string[] };
    return { seeks: w.__seeks, modes: w.__modes };
  });
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  const settled = modes.slice(-8); // last ~2 s
  console.log("after host jump:", { guestSeeks: seeks, driftModes: modes.join(" ") });
  expect(seeks).toBeLessThanOrEqual(2);
  expect(settled.some((m) => /seek/i.test(m))).toBe(false);

  await video(host).evaluate((v: HTMLVideoElement) => v.pause());
  await expect.poll(async () => (await state(guest)).paused, { timeout: 15_000 }).toBe(true);
  await expect.poll(async () => Math.abs((await state(guest)).t - (await state(host)).t), { timeout: 15_000 }).toBeLessThan(0.1);
});
