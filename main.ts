/**
 * - Goes to /antrean
 * - Selects target butik (Serpong)
 * - Clicks "Tampilkan Butik"
 * - Reads "Sisa" then stops (keeps browser open)
 *
 * Run:
 *   LM_USER="email" LM_PASS="pass" npx ts-node test.ts
 */

import path from "path";
import { promises as fs } from "fs";
import dotenv from "dotenv";
dotenv.config();
// puppeteer-real-browser has shaky TS types, keep it simple:
const { connect } = require("puppeteer-real-browser") as any;

// ================= CONFIGURATION =================
const LOGIN_URL = "https://antrean.logammulia.com/login";
const USERS_URL = "https://antrean.logammulia.com/users";
const ANTREAN_URL = "https://antrean.logammulia.com/antrean";

const USERNAME = process.env.LM_USER || "syamsulza@gmail.com";
const PASSWORD = process.env.LM_PASS || "12345678";

const TARGET_SITE_VALUE = "23";
const TARGET_SITE_LABEL = "Butik Emas LM - Serpong";

const POST_LOGIN_TIMEOUT = 120_000; // 120s
const OUT_DIR = path.join(__dirname, "debug_out");
const KEEP_BROWSER_OPEN = true;

type PageLike = any;
type BrowserLike = any;

(async () => {
  try {
    await fs.mkdir(OUT_DIR, { recursive: true });
  } catch {}
})();

// ================= HELPERS =================
function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

async function fillInputRobust(
  page: PageLike,
  selector: string,
  value: string | number,
  opts: { attempts?: number; delay?: number; verify?: boolean } = {}
) {
  const { attempts = 3, delay = 20, verify = true } = opts;

  await page.waitForSelector(selector, { visible: true, timeout: 20_000 });

  for (let i = 1; i <= attempts; i++) {
    const el = await page.$(selector);
    if (!el) throw new Error(`Element not found: ${selector}`);

    await el.focus();
    await page.keyboard.down(process.platform === "darwin" ? "Meta" : "Control");
    await page.keyboard.press("KeyA");
    await page.keyboard.up(process.platform === "darwin" ? "Meta" : "Control");
    await page.keyboard.press("Backspace");

    await el.type(String(value), { delay });

    if (!verify) return true;

    const ok = await page.$eval(
      selector,
      (input: any, expected: string) => input.value === expected,
      String(value)
    );
    if (ok) return true;

    await sleep(150);
  }

  const actual = await page.$eval(selector, (input: any) => input.value).catch(() => "");
  throw new Error(
    `Failed to fill ${selector}. Expected len=${String(value).length}, got len=${String(actual).length}`
  );
}

function stamp() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const h = String(now.getHours()).padStart(2, "0");
  const min = String(now.getMinutes()).padStart(2, "0");
  const s = String(now.getSeconds()).padStart(2, "0");
  return `${y}${m}${d}_${h}${min}${s}`;
}

async function dump(page: PageLike, tag: string) {
  const ts = stamp();

  try {
    const screenshotPath = path.join(OUT_DIR, `${ts}_${tag}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(`[dump] screenshot: ${screenshotPath}`);
  } catch (e: any) {
    console.log("[dump] screenshot failed:", e?.message || e);
  }

  try {
    const htmlPath = path.join(OUT_DIR, `${ts}_${tag}.html`);
    const html = await page.content();
    await fs.writeFile(htmlPath, html, "utf-8");
    console.log(`[dump] html: ${htmlPath}`);
  } catch (e: any) {
    console.log("[dump] html dump failed:", e?.message || e);
  }

  try {
    console.log("[dump] url:", page.url());
  } catch {}
}

function solveMath(questionText: string) {
  if (!questionText) return "";
  const t = questionText.toLowerCase();
  const nums = t.match(/\d+/g)?.map(Number) || [];
  if (nums.length < 2) return "";
  const [a, b] = nums;

  if (t.includes("dikurangi")) return String(a - b);
  if (t.includes("ditambah")) return String(a + b);
  if (t.includes("kali") || t.includes("dikali")) return String(a * b);
  if (t.includes("dibagi")) return b !== 0 ? String(Math.floor(a / b)) : "";
  return "";
}

async function safeEvaluate<T>(page: PageLike, fn: any, fallback: T, ...args: any[]): Promise<T> {
  try {
    return (await page.evaluate(fn, ...args)) as T;
  } catch {
    return fallback;
  }
}

async function waitForLoginDOM(page: PageLike, timeout = 120_000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const ok = await safeEvaluate<boolean>(
      page,
      () =>
        !!document.querySelector("#username") &&
        !!document.querySelector("#password") &&
        !!document.querySelector("#aritmetika") &&
        !!document.querySelector("#login"),
      false
    );
    if (ok) return true;
    await sleep(300);
  }
  return false;
}

async function waitUntilLoggedIn(page: PageLike, timeout = POST_LOGIN_TIMEOUT) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const url = String(page.url?.() || "").toLowerCase();
    if (url && !url.includes("/login")) return true;

    const hasLogout = await safeEvaluate<boolean>(
      page,
      () => !!document.querySelector('a[href*="/logout"], a[href*="logout"]'),
      false
    );
    if (hasLogout) return true;

    await sleep(400);
  }
  return false;
}

async function waitForTurnstileSolved(page: PageLike, timeout = 180_000) {
  const start = Date.now();

  await safeEvaluate<void>(
    page,
    () => {
      const btn: any = document.querySelector("#login");
      if (btn) btn.scrollIntoView({ block: "center", inline: "center" });
      window.scrollBy(0, 200);
    },
    undefined as any
  );

  while (Date.now() - start < timeout) {
    const solved = await safeEvaluate<boolean>(
      page,
      () => {
        const t1: any = document.querySelector('textarea[name="cf-turnstile-response"]');
        if (t1 && (t1.value || "").trim().length > 0) return true;

        const i1: any = document.querySelector('input[name="cf-turnstile-response"]');
        if (i1 && (i1.value || "").trim().length > 0) return true;

        return false;
      },
      false
    );

    if (solved) return true;
    await sleep(500);
  }
  return false;
}

// ================= CAPTCHA HANDLER FOR ANTREAN PAGE =================
async function waitForCaptchaIfPresent(page: PageLike, timeout = 120_000) {
  const hasTurnstile = await safeEvaluate<boolean>(
    page,
    () =>
      !!(
        document.querySelector('textarea[name="cf-turnstile-response"]') ||
        document.querySelector('input[name="cf-turnstile-response"]')
      ),
    false
  );

  if (hasTurnstile) {
    console.log("🔐 Captcha (Turnstile) detected on antrean page. Waiting for you to solve it...");
    const solved = await waitForTurnstileSolved(page, timeout);
    if (!solved) console.log("⚠️ Captcha not solved within timeout. Proceeding anyway (may fail).");
    else console.log("✅ Captcha solved.");
    return;
  }

  const checkboxSelectors = [
    'input[type="checkbox"][class*="captcha"]',
    "#captcha",
    ".g-recaptcha",
    'iframe[src*="recaptcha"]',
  ];

  for (const sel of checkboxSelectors) {
    const element = await page.$(sel).catch(() => null);
    if (element) {
      console.log(`🔲 Simple captcha element found (${sel}). Attempting to click it...`);
      try {
        await element.click();
        await sleep(1000);
        console.log("✅ Captcha checkbox clicked.");
      } catch (e: any) {
        console.log(`❌ Failed to click captcha checkbox: ${e?.message || e}`);
      }
      return;
    }
  }

  console.log("ℹ️ No captcha element detected on antrean page.");
}

// ================= ANTREAN INTERACTION =================
async function getSiteOptions(page: PageLike) {
  return await safeEvaluate<Array<{ value: string; text: string }>>(
    page,
    () => {
      const sel: any = document.querySelector("#site");
      if (!sel) return [];
      return Array.from(sel.querySelectorAll("option"))
        .map((o: any) => ({ value: (o.value || "").trim(), text: (o.innerText || "").trim() }))
        .filter((o: any) => o.value.length > 0);
    },
    []
  );
}

async function selectSiteRobust(page: PageLike, args: { value: string; label?: string }) {
  return await safeEvaluate<any>(
    page,
    ({ value, label }: any) => {
      const sel: any = document.querySelector("#site");
      if (!sel) return { ok: false, reason: "no_select" };

      const options = Array.from(sel.querySelectorAll("option")).map((o: any) => ({
        value: (o.value || "").trim(),
        text: (o.innerText || "").trim(),
      }));

      let chosen = options.find((o: any) => o.value === String(value));
      if (!chosen && label) {
        const needle = String(label).toLowerCase();
        chosen = options.find((o: any) => o.text.toLowerCase().includes(needle));
      }
      if (!chosen) return { ok: false, reason: "not_found", options };

      sel.value = chosen.value;
      sel.dispatchEvent(new Event("input", { bubbles: true }));
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true, chosen };
    },
    { ok: false, reason: "eval_failed" },
    args
  );
}

async function clickTampilkanButikByText(page: PageLike) {
  const clicked = await safeEvaluate<boolean>(
    page,
    () => {
      const buttons = Array.from(document.querySelectorAll("button"));
      const target: any = buttons.find(
        (b: any) => (b.innerText || "").trim().toLowerCase() === "tampilkan butik"
      );
      if (!target) return false;
      target.scrollIntoView({ block: "center" });
      target.click();
      return true;
    },
    false
  );

  if (clicked) return true;

  try {
    await page.waitForSelector('form[action*="/antrean"]', { timeout: 5000 });
    return await safeEvaluate<boolean>(
      page,
      () => {
        const form: any = document.querySelector('form[action*="/antrean"]');
        if (!form) return false;
        const btns = Array.from(form.querySelectorAll("button"));
        const target: any = btns.find((b: any) => (b.innerText || "").toLowerCase().includes("tampilkan"));
        if (!target) return false;
        target.scrollIntoView({ block: "center" });
        target.click();
        return true;
      },
      false
    );
  } catch {
    return false;
  }
}

async function clickButtonByText(page: PageLike, text: string) {
  const escaped = text.replace(/"/g, '\\"');

  const btnHandle =
    (await page.$x(`//button[contains(normalize-space(.), "${escaped}")]`))[0] ||
    (await page.$x(`//*[@role="button" and contains(normalize-space(.), "${escaped}")]`))[0];

  if (!btnHandle) return false;

  await btnHandle.evaluate((el: any) => el.scrollIntoView({ block: "center", inline: "center" }));
  await sleep(150);

  try {
    await btnHandle.click({ delay: 30 });
    return true;
  } catch {
    try {
      await btnHandle.evaluate((el: any) => el.click());
      return true;
    } catch {
      return false;
    }
  }
}

async function clickAmbilAntrean(page: PageLike) {
  const ok = await safeEvaluate<boolean>(
    page,
    () => {
      const form: any = document.querySelector('form[action*="/antrean-ambil"]');
      const root: any = form || document;

      const btns = Array.from(root.querySelectorAll("button"));
      const target: any = btns.find(
        (b: any) => (b.innerText || "").trim().toLowerCase() === "ambil antrean"
      );
      if (!target) return false;

      target.scrollIntoView({ block: "center" });
      target.click();
      return true;
    },
    false
  );

  if (ok) return true;
  return await clickButtonByText(page, "Ambil Antrean");
}

async function antreanResultReady(page: PageLike) {
  return await safeEvaluate<boolean>(
    page,
    () => {
      const hasAmbilForm = !!document.querySelector('form[action*="/antrean-ambil"]');
      const hasSisa = Array.from(document.querySelectorAll("div")).some((d: any) =>
        (d.innerText || "").includes("Sisa :")
      );
      return hasAmbilForm || hasSisa;
    },
    false
  );
}

async function readSisa(page: PageLike) {
  const txt = await safeEvaluate<string | null>(
    page,
    () => {
      const sisaBlock: any = Array.from(document.querySelectorAll("div")).find((d: any) =>
        (d.innerText || "").includes("Sisa :")
      );
      if (sisaBlock) {
        const b: any = sisaBlock.querySelector("span.badge");
        if (b) return b.innerText;
      }
      const badge: any = document.querySelector("span.badge");
      return badge ? badge.innerText : null;
    },
    null
  );

  if (!txt) return -1;
  const match = String(txt).match(/\d+/);
  return match ? parseInt(match[0], 10) : -1;
}

async function selectFirstWakdaOption(page: PageLike, opts: { skipZeroSlots?: boolean } = {}) {
  const { skipZeroSlots = false } = opts;

  await page.waitForSelector("#wakda", { timeout: 10_000 });

  const candidates = (await page.$$eval("#wakda option", (optsEls: any[]) => {
    return optsEls.map((o: any) => ({
      value: o.getAttribute("value") ?? "",
      text: (o.textContent || "").replace(/\s+/g, " ").trim(),
      disabled: !!o.disabled || o.getAttribute("disabled") !== null,
    }));
  })) as Array<{ value: string; text: string; disabled: boolean }>;

  let filtered = candidates.filter((o) => o.value && !o.disabled);

  if (skipZeroSlots) {
    filtered = filtered.filter((o) => !/\b0\s*\/\s*\d+\b/.test(o.text));
  }

  if (!filtered.length) {
    return { ok: false as const, reason: "no_valid_wakda_options", candidates };
  }

  const first = filtered[0];

  await page.select("#wakda", first.value);
  await page.evaluate(() => {
    const el: any = document.querySelector("#wakda");
    if (!el) return;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });

  return { ok: true as const, chosen: first, candidates };
}

// ================= VIEW SERPONG =================
async function viewSerpongOnce(page: PageLike) {
  if (!String(page.url?.() || "").toLowerCase().includes("/antrean")) {
    await page.goto(ANTREAN_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  }

  await page.waitForSelector("#site", { timeout: 20_000 });

  const options = await getSiteOptions(page);
  if (!options.length) {
    console.log("❌ No site options found.");
    await dump(page, "no_site_options");
    return { ok: false as const, reason: "no_site_options" };
  }

  const selRes = await selectSiteRobust(page, { value: TARGET_SITE_VALUE, label: TARGET_SITE_LABEL });

  if (!selRes.ok) {
    console.log("❌ Failed selecting site:", selRes.reason);
    console.log("   Available options sample:", options.slice(0, 10));
    await dump(page, "select_site_failed");
    return { ok: false as const, reason: "select_site_failed", details: selRes };
  }

  console.log(`[ok] Selected site: ${selRes.chosen.value} - ${selRes.chosen.text}`);
  await sleep(250);

  const clicked = await clickTampilkanButikByText(page);
  if (!clicked) {
    console.log("❌ Could not click 'Tampilkan Butik' button.");
    await dump(page, "click_tampilkan_failed");
    return { ok: false as const, reason: "click_tampilkan_failed" };
  }

  await Promise.race([
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 12_000 }).catch(() => null),
    (async () => {
      const start = Date.now();
      while (Date.now() - start < 12_000) {
        if (await antreanResultReady(page)) return true;
        await sleep(250);
      }
      return false;
    })(),
  ]);

  const start = Date.now();
  while (Date.now() - start < 8000) {
    if (await antreanResultReady(page)) break;
    await sleep(250);
  }

  const sisa = await readSisa(page);
  await dump(page, `serpong_result_sisa_${sisa}`);

  console.log(`\n===== RESULT =====`);
  console.log(`Butik: ${selRes.chosen.text}`);
  console.log(`Sisa : ${sisa}\n`);

  if (Number(sisa) > 0) {
    console.log("🟡 sisa > 0 -> select wakda then handle captcha and click Ambil Antrean...");

    await page.waitForSelector("#wakda", { timeout: 20_000 });

    const wakdaRes = await selectFirstWakdaOption(page, { skipZeroSlots: false });
    if (!wakdaRes.ok) {
      console.log("❌ Failed selecting wakda:", wakdaRes.reason);
      await dump(page, "select_wakda_failed");
      return {
        ok: true as const,
        site: selRes.chosen,
        sisa,
        auto: { step: "select_wakda", ...wakdaRes }, // no duplicate ok
      };
    }

    console.log(`✅ wakda selected: ${wakdaRes.chosen.value} - ${wakdaRes.chosen.text}`);
    await sleep(250);

    await waitForCaptchaIfPresent(page);

    const ambilClicked = await clickAmbilAntrean(page);
    if (!ambilClicked) {
      console.log("❌ Could not click 'Ambil Antrean'.");
      await dump(page, "click_ambil_failed");
      return { ok: true as const, site: selRes.chosen, sisa, auto: { ok: false, step: "click_ambil" } };
    }

    console.log("✅ Clicked Ambil Antrean.");
    await dump(page, "clicked_ambil_antrean");

    return {
      ok: true as const,
      site: selRes.chosen,
      sisa,
      auto: { ok: true, wakda: wakdaRes.chosen, clicked: "ambil_antrean" },
    };
  }

  return { ok: true as const, site: selRes.chosen, sisa };
}

// ================= MAIN =================
(async () => {
  console.log("Launching undetectable browser...");
  const { browser, page }: { browser: BrowserLike; page: PageLike } = await connect({
    headless: false,
    turnstile: true,
    defaultViewport: null,
    args: ["--start-maximized", "--window-position=0,0"],
  });

  // IMPORTANT: sometimes screen width reads 0 during navigation; guard it.
  const screen = await page.evaluate(() => ({
    width: window.screen.width || 1366,
    height: window.screen.height || 768,
    dpr: window.devicePixelRatio || 1,
  }));

  await page.setViewport({
    width: Math.max(800, Number(screen.width) || 1366),
    height: Math.max(600, Number(screen.height) || 768),
    deviceScaleFactor: Number(screen.dpr) || 1,
  });

  console.log("[viewport]", screen);
  let quitBrowser = true;

  try {
    console.log(`Navigating to ${LOGIN_URL}...`);
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });

    if (!(await waitForLoginDOM(page, 120_000))) {
      console.log("❌ Login DOM not found within 120s.");
      await dump(page, "login_dom_not_found");
      if (!KEEP_BROWSER_OPEN) await browser.close();
      return;
    }
    console.log("✅ Login DOM detected.");

    await fillInputRobust(page, "#username", USERNAME, { delay: 20 });
    await sleep(150);

    await fillInputRobust(page, "#password", PASSWORD, { delay: 20 });
    await sleep(150);

    const mathLabel = await page.$eval('label[for="aritmetika"]', (el: any) => el.innerText).catch(() => "");
    const mathAnswer = solveMath(mathLabel);
    console.log("[info] math label:", mathLabel);
    console.log("[info] math ans  :", mathAnswer);

    await page.click("#aritmetika", { clickCount: 3 }).catch(() => {});
    await page.type("#aritmetika", mathAnswer, { delay: 10 });
    await sleep(200);

    await safeEvaluate<void>(
      page,
      () => {
        const btn: any = document.querySelector("#login");
        if (btn) btn.scrollIntoView({ block: "center" });
        window.scrollBy(0, 200);
      },
      undefined as any
    );

    await dump(page, "login_filled_scrolled");

    console.log("\nNow solve Turnstile (if shown). I will wait until it is solved...");
    const tsSolved = await waitForTurnstileSolved(page, 180_000);
    if (!tsSolved) {
      console.log("⚠️ Turnstile token not detected within 180s.");
      await dump(page, "turnstile_not_detected");
    } else {
      console.log("✅ Turnstile solved detected (token filled).");
    }

    await page.waitForSelector("#login", { timeout: 10_000, visible: true });
    await safeEvaluate<void>(
      page,
      () => (document.querySelector("#login") as any)?.scrollIntoView({ block: "center" }),
      undefined as any
    );
    await sleep(200);

    console.log("[info] clicking login...");
    await page.click("#login");

    await Promise.race([
      page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: POST_LOGIN_TIMEOUT }).catch(() => {}),
      (async () => {
        const start = Date.now();
        while (Date.now() - start < POST_LOGIN_TIMEOUT) {
          const url = String(page.url?.() || "").toLowerCase();
          if (url && !url.includes("/login")) return true;
          await sleep(300);
        }
        return false;
      })(),
    ]);

    if (!(await waitUntilLoggedIn(page, POST_LOGIN_TIMEOUT))) {
      console.log("❌ Login did not complete (still on /login or no logout link).");
      await dump(page, "login_not_completed");
      if (!KEEP_BROWSER_OPEN) await browser.close();
      return;
    }

    console.log("✅ Logged in.");
    await dump(page, "logged_in");

    console.log("➡️ Redirecting directly to /antrean...");
    await page.goto(ANTREAN_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });

    await page.waitForSelector("#site", { timeout: 20_000 });
    console.log("✅ /antrean loaded directly.");

    const result = await viewSerpongOnce(page);

    console.log("\n✅ Final Result:");
    console.log(JSON.stringify(result, null, 2));

    if (KEEP_BROWSER_OPEN) {
      quitBrowser = false;
      console.log("\nBrowser will stay open. Press Ctrl+C to exit.");
      await new Promise<void>(() => {});
    }
  } catch (err: any) {
    console.error("❌ Fatal error:", err?.message || err);
    try {
      await dump(page, "fatal_error");
    } catch {}
    quitBrowser = false;
    console.log("Keeping browser open for inspection. Press Ctrl+C to exit.");
    await new Promise<void>(() => {});
  } finally {
    if (quitBrowser) await browser.close();
  }
})();