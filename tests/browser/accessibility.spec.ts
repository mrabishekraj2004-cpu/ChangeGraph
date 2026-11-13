import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

async function expectAccessible(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(results.violations, results.violations.map((item) => `${item.id}: ${item.help}`).join("\n")).toEqual([]);
}

async function expectNoHorizontalOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    overflowingElements: Array.from(document.querySelectorAll("body *"))
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return { tag: element.tagName, className: typeof element.className === "string" ? element.className : "", text: element.textContent?.trim().slice(0, 55) ?? "", left: Math.round(rect.left), right: Math.round(rect.right), width: Math.round(rect.width), scrollWidth: element.scrollWidth, clientWidth: element.clientWidth };
      })
      .filter((element) => element.width > 0 && (element.left < -1 || element.right > document.documentElement.clientWidth + 1))
      .slice(0, 12),
  }));
  expect(dimensions.scrollWidth, JSON.stringify(dimensions)).toBeLessThanOrEqual(dimensions.clientWidth + 1);
}

test.describe("ChangeGraph browser quality gate", () => {
  test("landing and authentication surfaces are keyboard and WCAG-clean", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Find the change");
    await expectAccessible(page);

    await page.goto("/login");
    await expect(page.getByLabel("Email")).toBeVisible();
    await expect(page.getByLabel("Password")).toBeVisible();
    await expect(page.getByText("demo@changegraph.dev · demo1234")).toHaveCount(0);
    await expectAccessible(page);

    await page.getByLabel("Email").fill("not-a-user@example.com");
    await page.getByLabel("Password").fill("incorrect-password");
    const failedLogin = page.waitForResponse((response) => response.url().endsWith("/api/auth/login") && response.request().method() === "POST");
    await page.getByRole("button", { name: "Sign in" }).click();
    expect((await failedLogin).status()).toBe(401);
    await expect(page.locator(".auth-error")).toContainText("incorrect", { timeout: 30_000 });
  });

  test("demo investigation shell stays usable at desktop and mobile widths", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Email").fill("demo@changegraph.dev");
    await page.getByLabel("Password").fill("demo1234");
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL("**/overview");

    await expect(page.getByRole("navigation", { name: "Primary navigation" })).toBeVisible();
    await expect(page.locator("#main-content")).toBeVisible();
    await expectAccessible(page);
    await expectNoHorizontalOverflow(page);

    await page.setViewportSize({ width: 768, height: 1024 });
    await page.reload();
    await expect(page.getByRole("navigation", { name: "Primary navigation" })).toBeVisible();
    await expectNoHorizontalOverflow(page);

    await page.setViewportSize({ width: 375, height: 812 });
    await page.reload();
    await expect(page.getByRole("navigation", { name: "Primary navigation" })).toBeVisible();
    await expectNoHorizontalOverflow(page);

    await page.getByRole("button", { name: "Help" }).click();
    const help = page.getByRole("dialog", { name: "Investigation guardrails" });
    await expect(help).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(help).toBeHidden();
    await expect(page.getByRole("button", { name: "Help" })).toBeFocused();

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.reload();
    await page.getByRole("button", { name: "Log out" }).click();
    await page.waitForURL("**/login");
  });

  test("product sections remain accessible and fit desktop, tablet, and mobile", async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto("/login");
    await page.getByLabel("Email").fill("demo@changegraph.dev");
    await page.getByLabel("Password").fill("demo1234");
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL("**/overview");

    const paths = ["/overview", "/incidents", "/incidents/inc_1047", "/services", "/changes", "/integrations", "/evaluations", "/settings", "/settings/integrations"];
    for (const path of paths) {
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(path);
      await expect(page.locator("#main-content")).toBeVisible();
      await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
      await expectAccessible(page);

      for (const viewport of [{ width: 768, height: 1024 }, { width: 375, height: 812 }]) {
        await page.setViewportSize(viewport);
        await expectNoHorizontalOverflow(page);
      }
    }

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole("button", { name: "Log out" }).click();
    await page.waitForURL("**/login");
  });
});
