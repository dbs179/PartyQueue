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

  test("js modules are served as ES modules", async ({ request }) => {
    const main = await request.get("/js/main.js?v=smoke");
    expect(main.ok()).toBeTruthy();
    const modal = await request.get("/js/modal.js");
    expect(modal.ok()).toBeTruthy();
    expect(await modal.text()).toMatch(/export function attachModal/);
  });
});
