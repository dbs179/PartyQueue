import { test, expect } from "@playwright/test";

const ONE_PX_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

async function mockCover(page, pathLiteral) {
  await page.route(`**${pathLiteral}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "image/png",
      body: ONE_PX_PNG,
    })
  );
}

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
      positionAgeSec: 0.25,
      positionObservedAt: Date.now(),
      reactions: { heart: 3, party: 2 },
      streamSession: "display-smoke",
      streamSequence: 1,
    };
    await page.route("**/api/nowplaying/stream", (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body:
          `event: sonos-status\ndata: ${JSON.stringify({
            status: "connected",
            consecutiveFailures: 0,
            lastSuccessAt: Date.now(),
          })}\n\n` + `data: ${JSON.stringify(nowPlaying)}\n\n`,
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
    await expect(page.locator(".party-display-kicker")).toHaveCount(0);
    await expect(page.locator("#display-event-name")).toHaveClass(
      /party-display-label/
    );
    const brandedTitle =
      (await page.locator("#event-name").textContent()) || "PartyQueue";
    await expect(page.locator("#display-event-name")).toHaveText(
      brandedTitle
    );
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
    await expect(page.locator("#display-progress")).toBeVisible();
    const toSeconds = (value) =>
      String(value)
        .split(":")
        .map(Number)
        .reduce((total, part) => total * 60 + part, 0);
    const displayBefore = toSeconds(
      await page.locator("#display-progress-elapsed").textContent()
    );
    await expect
      .poll(
        async () =>
          toSeconds(
            await page.locator("#display-progress-elapsed").textContent()
          ),
        { timeout: 4_000 }
      )
      .toBeGreaterThan(displayBefore);
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

  test("pending transition keeps prior art and never blanks to Changing track", async ({
    page,
  }) => {
    const confirmed = {
      queueTrack: 1,
      title: "Live Song",
      artist: "Live Artist",
      album: "Live Album",
      albumArt: "/live-cover.jpg",
      uri: "spotify:track:live",
      metadataPending: false,
      isPlaying: true,
      queuePlaying: true,
      positionSec: 42,
      durationSec: 180,
      reactions: {},
      streamSession: "pending-smoke",
      streamSequence: 1,
    };
    const pending = {
      ...confirmed,
      queueTrack: 2,
      metadataPending: true,
      positionSec: 0,
      streamSequence: 2,
    };
    await mockCover(page, "/live-cover.jpg");
    await mockCover(page, "/next-cover.jpg");
    await page.route("**/api/nowplaying/stream", (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body:
          `data: ${JSON.stringify(confirmed)}\n\n` +
          `data: ${JSON.stringify(pending)}\n\n`,
      })
    );
    // Initial HTTP fetch must also be confirmed so lastConfirmed is seeded
    // before the pending SSE event arrives.
    await page.route("**/api/nowplaying", (route) =>
      route.fulfill({ status: 200, json: confirmed })
    );
    await page.route("**/api/queue/stream", (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: `data: ${JSON.stringify({
          tracks: [
            {
              position: 2,
              title: "Next Song",
              artist: "Next Artist",
              albumArt: "/next-cover.jpg",
              uri: "spotify:track:next",
            },
          ],
          streamSession: "pending-queue",
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
              position: 2,
              title: "Next Song",
              artist: "Next Artist",
              albumArt: "/next-cover.jpg",
              uri: "spotify:track:next",
            },
          ],
        },
      })
    );
    const lyricsUrls = [];
    await page.route(/\/api\/lyrics\?/, (route) => {
      lyricsUrls.push(route.request().url());
      return route.fulfill({
        status: 200,
        json: {
          found: true,
          syncedLyrics: "[00:01.00]Kept lyrics",
          plainLyrics: "Kept lyrics",
          provider: "lrclib",
        },
      });
    });

    await page.goto("/");
    await expect(page.locator("#np-title")).toHaveText("Live Song");
    await expect(page.locator("#np-title")).not.toHaveText("Changing track…");
    await expect(page.locator("#np-art")).toHaveAttribute("src", /live-cover/);
    await expect(page.locator("#np-state")).toHaveText("Updating");
    await expect(page.locator("#np-progress")).toBeVisible();

    await page.locator("#np-card").click();
    await expect(page.locator("#np-fs-title")).toHaveText("Live Song");
    await expect(page.locator(".np-fs-lyrics-status")).not.toHaveText(
      "Changing track…"
    );
    await expect(page.locator(".np-fs-line")).toContainText("Kept lyrics");
    const decodedLyricsUrls = lyricsUrls.map((url) =>
      decodeURIComponent(String(url).replace(/\+/g, "%20"))
    );
    expect(decodedLyricsUrls.some((url) => url.includes("Live Song"))).toBeTruthy();
    expect(decodedLyricsUrls.some((url) => url.includes("Previous"))).toBeFalsy();

    await page.keyboard.press("Escape");
    await page.evaluate(() => {
      location.hash = "#/display";
    });
    await expect(page.locator("#view-display")).toBeVisible();
    await expect(page.locator("#display-title")).toHaveText("Live Song");
    await expect(page.locator("#display-state")).toHaveText("Updating");
    await expect(page.locator("#display-art")).toHaveAttribute(
      "src",
      /live-cover/
    );
    await expect(page.locator("#display-progress")).toBeVisible();
  });

  test("host skip paints optimistic next cover without Changing track", async ({
    page,
  }) => {
    const nowPlaying = {
      queueTrack: 1,
      title: "Current Song",
      artist: "Current Artist",
      album: "Current Album",
      albumArt: "/current-cover.jpg",
      uri: "spotify:track:current",
      metadataPending: false,
      isPlaying: true,
      queuePlaying: true,
      positionSec: 20,
      durationSec: 200,
      reactions: {},
      streamSession: "skip-smoke",
      streamSequence: 1,
    };
    const queueTracks = [
      {
        position: 2,
        title: "Queued Next",
        artist: "Queued Artist",
        albumArt: "/queued-cover.jpg",
        uri: "spotify:track:queued",
      },
    ];
    await mockCover(page, "/current-cover.jpg");
    await mockCover(page, "/queued-cover.jpg");
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
          tracks: queueTracks,
          streamSession: "skip-queue",
          streamSequence: 1,
        })}\n\n`,
      })
    );
    await page.route("**/api/queue/list", (route) =>
      route.fulfill({ status: 200, json: { tracks: queueTracks } })
    );
    await page.route("**/api/next", (route) =>
      route.fulfill({ status: 200, json: { ok: true } })
    );
    await page.route(/\/api\/lyrics\?/, (route) =>
      route.fulfill({ status: 200, json: { found: false } })
    );

    await page.goto("/");
    await expect(page.locator("#np-title")).toHaveText("Current Song");
    await page.locator("#controls-toggle").click();
    await expect(page.locator("#next-btn")).toBeVisible();
    await page.locator("#next-btn").click();
    await expect(page.locator("#np-title")).toHaveText("Queued Next");
    await expect(page.locator("#np-title")).not.toHaveText("Changing track…");
    await expect(page.locator("#np-art")).toHaveAttribute("src", /queued-cover/);
    await expect(page.locator("#np-state")).toHaveText("Updating");
  });

  test("js modules are served as ES modules", async ({ request }) => {
    const main = await request.get("/js/main.js?v=smoke");
    expect(main.ok()).toBeTruthy();
    const modal = await request.get("/js/modal.js");
    expect(modal.ok()).toBeTruthy();
    expect(await modal.text()).toMatch(/export function attachModal/);
  });
});
