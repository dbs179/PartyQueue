import { test, expect } from "@playwright/test";

test.describe("PartyQueue browser smoke", () => {
  test("main view loads the ESM UI and sticky search", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#search")).toBeVisible();
    await expect(page.locator("#guest-name")).toContainText(/Set your name/i);
    await expect(page.locator("#view-main")).toBeVisible();
  });

  test("name modal traps focus and closes on Escape", async ({ page }) => {
    await page.goto("/");
    await page.locator("#guest-name").click();
    const nameInput = page.locator("#name-input");
    await expect(nameInput).toBeVisible();
    await expect(nameInput).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.locator("#name-overlay")).toBeHidden();
    await expect(page.locator("body")).not.toHaveClass(/modal-open/);
  });

  test("hash navigation reaches Stats without a reload", async ({ page }) => {
    await page.goto("/");
    await page.evaluate(() => {
      location.hash = "#stats";
    });
    await expect(page.locator("#view-stats")).toBeVisible();
    await expect(page.locator("#view-main")).toBeHidden();
  });

  test("Party Display is a read-only deep-linked view", async ({ page }) => {
    const nowPlaying = {
      title: "Midnight City",
      artist: "M83",
      album: "Hurry Up, We're Dreaming",
      albumArt: "",
      uri: "spotify:track:display-test",
      state: "PLAYING",
      isPlaying: true,
      queuePlaying: true,
      durationSec: 240,
      positionSec: 60,
      positionObservedAt: Date.now(),
      reactions: { heart: 3, party: 2 },
      streamSession: "display-smoke",
      streamSequence: 1,
    };
    await page.route("**/api/nowplaying/stream", (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: `data: ${JSON.stringify(nowPlaying)}\n\n`,
      })
    );
    await page.route("**/api/nowplaying", (route) =>
      route.fulfill({ status: 200, json: nowPlaying })
    );
    await page.route(/\/api\/reactions\?/, (route) =>
      route.fulfill({
        status: 200,
        json: { heart: 3, party: 2, mine: null, micMine: false },
      })
    );
    await page.route("**/api/queue/stream", (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: `data: ${JSON.stringify({
          tracks: [
            {
              title: "Electric Feel",
              artist: "MGMT",
              position: 2,
              requestedBy: "Alex",
              searched: true,
            },
          ],
          streamSession: "queue-display-smoke",
          streamSequence: 1,
        })}\n\n`,
      })
    );
    await page.route("**/api/queue/list", (route) =>
      route.fulfill({
        status: 200,
        json: {
          tracks: [
            {
              title: "Fallback Song",
              artist: "Fallback Artist",
              position: 2,
            },
          ],
        },
      })
    );
    await page.route("**/api/join", (route) =>
      route.fulfill({
        status: 200,
        json: {
          url: "http://partyqueue.local",
          qrSvg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
        },
      })
    );

    await page.goto("/#/display");
    await expect(page.locator("#view-display")).toBeVisible();
    await expect(page.locator("#view-main")).toBeHidden();
    await expect(page.locator("body")).toHaveClass(/party-display-active/);
    await expect(page.locator("#display-title")).toBeAttached();
    await expect(page.locator("#display-queue")).toBeAttached();
    await expect(page.locator("#display-join-qr")).toBeAttached();
    await expect(page.locator("#display-title")).toHaveText("Midnight City");
    await expect(page.locator("#display-artist")).toHaveText("M83");
    await expect(page.locator("#display-queue")).toContainText("Electric Feel");
    await expect(page.locator("#display-queue")).toContainText("Requested by Alex");
    await expect(page.locator('[data-display-count="heart"]')).toHaveText("3");
    await expect(page.locator("#display-join-url")).toHaveText(
      "http://partyqueue.local"
    );
    await expect(page.locator("#view-display button")).toHaveCount(0);
    await expect(page.locator("#np-toggle")).toBeHidden();
  });

  test("album art keeps time moving and retries busy lyrics", async ({ page }) => {
    const nowPlaying = {
      title: "Clock Test",
      artist: "PartyQueue",
      album: "Timing",
      albumArt: "",
      uri: "spotify:track:clock-test",
      state: "PLAYING",
      isPlaying: true,
      queuePlaying: true,
      durationSec: 240,
      positionSec: 60,
      positionAgeSec: 0,
      reactions: {},
      streamSession: "clock-smoke",
      streamSequence: 1,
    };
    await page.route("**/api/nowplaying/stream", (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: `data: ${JSON.stringify(nowPlaying)}\n\n`,
      })
    );
    await page.route("**/api/nowplaying", (route) =>
      route.fulfill({ status: 200, json: nowPlaying })
    );
    await page.route("**/api/queue/stream", (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: `data: ${JSON.stringify({
          tracks: [],
          streamSession: "clock-queue",
          streamSequence: 1,
        })}\n\n`,
      })
    );
    await page.route("**/api/queue/list", (route) =>
      route.fulfill({ status: 200, json: { tracks: [] } })
    );
    let lyricsRequests = 0;
    await page.route(/\/api\/lyrics\?/, (route) => {
      lyricsRequests += 1;
      if (lyricsRequests === 1) {
        return route.fulfill({
          status: 503,
          json: {
            error: "Lyrics service is temporarily busy.",
            retryAfterSec: 1,
          },
        });
      }
      return route.fulfill({
        status: 200,
        json: {
          found: true,
          syncedLyrics: "[01:00.00]Recovered lyrics",
          provider: "unison",
          syncKind: "line",
          attribution: {
            text: "Lyrics from Unison",
            url: "https://unisonlyrics.org",
          },
        },
      });
    });

    await page.goto("/");
    await expect(page.locator("#np-title")).toHaveText("Clock Test");
    await page.waitForTimeout(1_500);
    const before = await page.locator("#np-progress-elapsed").textContent();

    await page.locator("#np-card").click();
    await expect(page.locator("#np-overlay")).toBeVisible();
    const after = await page.locator("#np-fs-progress-elapsed").textContent();

    const seconds = (value) => {
      const parts = String(value).split(":").map(Number);
      return parts.reduce((total, part) => total * 60 + part, 0);
    };
    expect(seconds(after)).toBeGreaterThanOrEqual(seconds(before));
    await expect(page.locator(".np-fs-line")).toContainText(
      "Recovered lyrics",
      { timeout: 3_000 }
    );
    await expect(page.locator(".np-fs-lyrics-attribution a")).toHaveText(
      "Lyrics from Unison"
    );
    await expect(page.locator(".np-fs-lyrics-attribution a")).toHaveAttribute(
      "href",
      "https://unisonlyrics.org"
    );
    expect(lyricsRequests).toBe(2);
  });

  test("metadata-pending transition never paints stale art or lyrics", async ({
    page,
  }) => {
    const pending = {
      queueTrack: 2,
      title: "Previous Song",
      artist: "Previous Artist",
      album: "Previous Album",
      albumArt: "/stale-cover.jpg",
      uri: "spotify:track:previous",
      metadataPending: true,
      isPlaying: true,
      queuePlaying: true,
      positionSec: 0,
      durationSec: 180,
      reactions: {},
      streamSession: "pending-smoke",
      streamSequence: 1,
    };
    await page.route("**/api/nowplaying/stream", (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: `data: ${JSON.stringify(pending)}\n\n`,
      })
    );
    await page.route("**/api/nowplaying", (route) =>
      route.fulfill({ status: 200, json: pending })
    );
    await page.route("**/api/queue/stream", (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: `data: ${JSON.stringify({
          tracks: [],
          streamSession: "pending-queue",
          streamSequence: 1,
        })}\n\n`,
      })
    );
    await page.route("**/api/queue/list", (route) =>
      route.fulfill({ status: 200, json: { tracks: [] } })
    );
    let lyricsRequests = 0;
    await page.route(/\/api\/lyrics\?/, (route) => {
      lyricsRequests += 1;
      return route.abort();
    });

    await page.goto("/");
    await expect(page.locator("#np-title")).toHaveText("Changing track…");
    await expect(page.locator("#np-art")).not.toHaveAttribute("src", /.+/);
    await page.locator("#np-card").click();
    await expect(page.locator("#np-fs-title")).toHaveText("Changing track…");
    await expect(page.locator(".np-fs-lyrics-status")).toHaveText(
      "Changing track…"
    );
    expect(lyricsRequests).toBe(0);
  });

  test("js modules are served as ES modules", async ({ request }) => {
    const main = await request.get("/js/main.js?v=smoke");
    expect(main.ok()).toBeTruthy();
    const modal = await request.get("/js/modal.js");
    expect(modal.ok()).toBeTruthy();
    expect(await modal.text()).toMatch(/export function attachModal/);
  });
});
