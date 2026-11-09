import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Guards the SEO basics in index.html: a typo'd asset path or an overlong description fails here.
const root = resolve(__dirname, "..");
const html = readFileSync(resolve(root, "index.html"), "utf8");
const meta = (attr: string, name: string) =>
  new RegExp(`<meta\\s+${attr}="${name}"\\s+content="([^"]*)"`, "s").exec(html)?.[1];

describe("index.html SEO", () => {
  it("has a title and a description short enough not to be truncated", () => {
    expect(/<title>(.+)<\/title>/.exec(html)?.[1].length).toBeLessThanOrEqual(70);
    expect(meta("name", "description")!.length).toBeLessThanOrEqual(160);
  });

  it("uses absolute canonical and social-image URLs on the same origin", () => {
    const canonical = /<link rel="canonical" href="([^"]+)"/.exec(html)![1];
    expect(canonical).toMatch(/^https:\/\//);
    expect(meta("property", "og:url")).toBe(canonical);
    expect(meta("property", "og:image")).toBe(`${new URL(canonical).origin}/og-image.png`);
    expect(meta("name", "twitter:image")).toBe(meta("property", "og:image"));
  });

  it("has valid JSON-LD", () => {
    const json = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)![1];
    expect(JSON.parse(json)["@type"]).toBe("WebApplication");
  });

  it("references only files that exist in public/", () => {
    const refs = [...html.matchAll(/(?:href|content)="(\/[^"#?]+\.[a-z]+)"/g)].map((m) => m[1]);
    expect(refs.length).toBeGreaterThan(5);
    for (const ref of refs) expect(existsSync(resolve(root, "public", ref.slice(1))), ref).toBe(true);
  });

  it("lists the sitemap in robots.txt and the manifest icons exist", () => {
    expect(readFileSync(resolve(root, "public/robots.txt"), "utf8")).toMatch(/^Sitemap: https:\/\/.+\/sitemap\.xml$/m);
    const manifest = JSON.parse(readFileSync(resolve(root, "public/manifest.webmanifest"), "utf8"));
    for (const icon of manifest.icons) expect(existsSync(resolve(root, "public", icon.src.slice(1))), icon.src).toBe(true);
  });
});
