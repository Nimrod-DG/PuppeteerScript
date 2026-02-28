/**
 * - Goes to /antrean
 * - Selects target butik (Serpong)
 * - Clicks "Tampilkan Butik"
 * - Reads "Sisa"
 * - If sisa > 0: select wakda, wait captcha, click Ambil Antrean
 * - Keeps browser open (KEEP_BROWSER_OPEN)
 *
 * Run (local visible):
 *   npm start
 *
 * Run (headless, e.g. Docker):
 *   HEADLESS=true npm start
 *
 * Run (ts-node):
 *   LM_USER="email" LM_PASS="pass" npx ts-node test.ts
 */

import path from "path";
import { promises as fs } from "fs";
import dotenv from "dotenv";
dotenv.config();

// puppeteer-real-browser has shaky TS types, keep it simple:
const { connect } = require("puppeteer-real-browser") as any;

const MAX_LOGIN_ATTEMPTS = Number(process.env.MAX_LOGIN_ATTEMPTS || 10);

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

// Headless mode – set HEADLESS=true for Docker, false for local visible window
const HEADLESS = process.env.HEADLESS === "true";

type PageLike = any;
type BrowserLike = any;

// ================= LOGGING HELPERS =================
function isoTs() {
  return new Date().toISOString();
}
function log(...args: any[]) {
  console.log(`[${isoTs()}]`, ...args);
}
function warn(...args: any[]) {
  console.log(`[${isoTs()}] ⚠️`, ...args);
}
function errorLog(...args: any[]) {
  console.log(`[${isoTs()}] ❌`, ...args);
}

// Progress logger to avoid "looks stuck" in Docker/headless logs
function startProgress(label: string, everyMs = 10_000) {
  let alive = true;
  const t0 = Date.now();
  const timer = setInterval(() => {
    if (!alive) return;
    const sec = Math.floor((Date.now() - t0) / 1000);
    log(`[progress] ${label} (${sec}s) ...`);
  }, everyMs);

  return () => {
    alive = false;
    clearInterval(timer);
  };
}

(async () => {
  try {
    await fs.mkdir(OUT_DIR, { recursive: true });
  } catch {}
})();

// ================= HELPERS =================
function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

// ================= PATCH START =================
// fillInputRobust – unchanged (kept for completeness)
async function fillInputRobust(
  page: PageLike,
  selector: string,
  value: string | number,
  opts: { attempts?: number; delay?: number; verify?: boolean } = {}
) {
  const { attempts = 4, delay = 10, verify = true } = opts;

  await page.waitForSelector(selector, { visible: true, timeout: 20_000 });

  const expected = String(value);

  for (let i = 1; i <= attempts; i++) {
    try {
      const ok = await safeEvaluate<boolean>(
        page,
        ({ selector, expected }: any) => {
          const el = document.querySelector(selector) as HTMLInputElement | HTMLTextAreaElement | null;
          if (!el) return false;

          // Focus + scroll into view
          (el as any).focus?.();
          (el as any).scrollIntoView?.({ block: "center", inline: "center" });

          // Use the native value setter (works better with React/Vue/etc)
          const proto =
            el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const desc = Object.getOwnPropertyDescriptor(proto, "value");
          const setter = desc?.set;

          // Clear then set
          if (setter) {
            setter.call(el, "");
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));

            setter.call(el, expected);
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
          } else {
            // Fallback: direct assignment
            (el as any).value = expected;
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
          }

          return (el.value ?? "") === expected;
        },
        false,
        { selector, expected }
      );

      if (ok) return true;

      // If not ok, do a short typing fallback (sometimes sites block setter)
      const el = await page.$(selector);
      if (!el) throw new Error(`Element not found: ${selector}`);

      await el.click({ clickCount: 3 });
      await page.keyboard.press("Backspace");

      // Type slowly; some sites drop keystrokes at speed
      await page.type(selector, expected, { delay });

      if (!verify) return true;

      const ok2 = await page
        .$eval(selector, (input: any, exp: string) => (input.value ?? "") === exp, expected)
        .catch(() => false);

      if (ok2) return true;

      const actual = await page.$eval(selector, (input: any) => input.value).catch(() => "");
      warn(
        `[fill] mismatch attempt ${i}/${attempts} for ${selector}: got len=${String(actual).length}, want len=${expected.length}`
      );

      await sleep(200);
    } catch (e: any) {
      warn(`[fill] attempt ${i}/${attempts} error on ${selector}:`, e?.message || e);
      await sleep(250);
    }
  }

  const actual = await page.$eval(selector, (input: any) => input.value).catch(() => "");
  throw new Error(`Failed to fill ${selector}. Expected len=${expected.length}, got len=${String(actual).length}`);
}
// ================= PATCH END =================

async function ensureLoginInputsCorrect(page: PageLike, opts: { attempts?: number } = {}) {
  const { attempts = 3 } = opts;

  for (let i = 1; i <= attempts; i++) {
    // Read current DOM values
    const cur = await safeEvaluate(
      page,
      () => ({
        u: (document.querySelector("#username") as HTMLInputElement | null)?.value ?? "",
        p: (document.querySelector("#password") as HTMLInputElement | null)?.value ?? "",
        a: (document.querySelector("#aritmetika") as HTMLInputElement | null)?.value ?? "",
      }),
      { u: "", p: "", a: "" }
    );

    const wantU = String(USERNAME);
    const wantP = String(PASSWORD);

    // For aritmetika, compute expected from label again (in case it changed)
    const label = await page
      .$eval('label[for="aritmetika"]', (el: any) => el.innerText)
      .catch(() => "");
    const wantA = solveMath(label);

    const okU = cur.u === wantU;
    const okP = cur.p === wantP;
    const okA = wantA ? cur.a === wantA : true; // if empty label/parse, don't block

    if (okU && okP && okA) return { ok: true as const, cur, want: { u: wantU, p: "***", a: wantA } };

    warn(`[guard] login inputs mismatch (attempt ${i}/${attempts})`, {
      okU,
      okP,
      okA,
      got: { uLen: cur.u.length, pLen: cur.p.length, a: cur.a },
      wantA,
    });

    // Re-fill only what is wrong
    if (!okU) await fillInputRobust(page, "#username", wantU, { delay: 15, verify: true });
    if (!okP) await fillInputRobust(page, "#password", wantP, { delay: 15, verify: true });
    if (!okA && wantA) await fillInputRobust(page, "#aritmetika", wantA, { delay: 10, verify: true });

    await sleep(150);
  }

  return { ok: false as const };
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
    log(`[dump] screenshot: ${screenshotPath}`);
  } catch (e: any) {
    warn("[dump] screenshot failed:", e?.message || e);
  }

  try {
    const htmlPath = path.join(OUT_DIR, `${ts}_${tag}.html`);
    const html = await page.content();
    await fs.writeFile(htmlPath, html, "utf-8");
    log(`[dump] html: ${htmlPath}`);
  } catch (e: any) {
    warn("[dump] html dump failed:", e?.message || e);
  }

  try {
    log("[dump] url:", page.url());
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

// ================= ROBUST CHALLENGE HANDLER =================
/**
 * Waits for the Turnstile challenge to be solved.
 * - Checks for login form
 * - Checks for Turnstile token field with value
 * - If still on challenge page after half timeout, reloads once
 * - Attempts to click the "Verify" checkbox if an iframe is found
 * @param page Puppeteer page
 * @param timeout max wait time in ms
 * @returns true if login DOM is ready, false if timeout
 */
async function waitForChallengeAndLoginDOM(page: PageLike, timeout = 300_000): Promise<boolean> {
  const start = Date.now();
  const halfTimeout = timeout / 2;
  let reloaded = false;
  const stopProgress = startProgress("Waiting for challenge to be solved and login DOM", 10_000);

  try {
    while (Date.now() - start < timeout) {
      // Check if login form is present
      const hasLoginForm = await safeEvaluate<boolean>(
        page,
        () =>
          !!document.querySelector("#username") &&
          !!document.querySelector("#password") &&
          !!document.querySelector("#aritmetika") &&
          !!document.querySelector("#login"),
        false
      );
      if (hasLoginForm) {
        log("[challenge] Login form detected – challenge solved.");
        return true;
      }

      // Check if Turnstile token exists and has a value
      const tokenSolved = await safeEvaluate<boolean>(
        page,
        () => {
          const tokenField =
            document.querySelector<HTMLTextAreaElement>('textarea[name="cf-turnstile-response"]') ||
            document.querySelector<HTMLInputElement>('input[name="cf-turnstile-response"]');
          return !!(tokenField && tokenField.value.trim().length > 0);
        },
        false
      );
      if (tokenSolved) {
        log("[challenge] Turnstile token detected – challenge solved.");
        // Give the page a moment to update
        await sleep(1000);
        continue;
      }

      // Check for Turnstile iframe and try to click the checkbox (fallback)
      const iframeClicked = await safeEvaluate<boolean>(
        page,
        () => {
          const iframe = document.querySelector<HTMLIFrameElement>('iframe[src*="turnstile"]');
          if (iframe) {
            try {
              // Try to access iframe content and click the checkbox
              const doc = iframe.contentDocument || (iframe.contentWindow && iframe.contentWindow.document);
              if (doc) {
                const checkbox = doc.querySelector('input[type="checkbox"]');
                if (checkbox) {
                  (checkbox as HTMLElement).click();
                  return true;
                }
              }
            } catch (e) {
              // Cross-origin restrictions – ignore
            }
          }
          return false;
        },
        false
      );
      if (iframeClicked) {
        log("[challenge] Clicked Turnstile iframe checkbox.");
        await sleep(2000);
      }

      // Check if we are still on the challenge page (by looking for "Verifying you are human")
      const isChallengePage = await safeEvaluate<boolean>(
        page,
        () => {
          const bodyText = document.body?.innerText || "";
          return bodyText.includes("Verifying you are human") || bodyText.includes("Ray ID:");
        },
        false
      );

      if (isChallengePage) {
        log("[challenge] Still on challenge page.");
        // If we've been waiting for more than half the timeout, try reloading once
        if (!reloaded && Date.now() - start > halfTimeout) {
          warn("[challenge] Reloading page to trigger solver...");
          await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
          reloaded = true;
          await sleep(2000);
          continue;
        }
      } else {
        // Not challenge page, but also no login form – maybe something else
        log("[challenge] Page is not the challenge page, but login form not yet visible.");
      }

      await sleep(1000);
    }

    warn(`[challenge] Not solved within ${timeout}ms.`);
    await dump(page, "challenge_timeout");
    return false;
  } finally {
    stopProgress();
  }
}

async function waitForLoginDOM(page: PageLike, timeout = 120_000) {
  const start = Date.now();
  const stopProgress = startProgress("Waiting for login DOM (#username/#password/#aritmetika/#login)", 10_000);
  try {
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
  } finally {
    stopProgress();
  }
}

const HOME_URL = "https://antrean.logammulia.com/home";

async function ensureOnLoginPageEntry(page: PageLike) {
  const url = String(page.url?.() || "").toLowerCase();
  log("[route] current url:", url);

  if (url.includes("/home")) {
    log("[route] on /home -> waiting for Log In button...");

    await page
      .waitForSelector('a.btn-gradient[href*="/login"]', { visible: true, timeout: 20_000 })
      .catch(() => null);

    let clicked = false;
    try {
      const a = await page.$('a.btn-gradient[href*="/login"]');
      if (a) {
        await a.evaluate((el: any) => el.scrollIntoView({ block: "center" }));
        await sleep(150);
        await a.click({ delay: 30 });
        clicked = true;
        log("[route] clicked login button from /home");
      }
    } catch {}

    if (!clicked) {
      clicked = await safeEvaluate<boolean>(
        page,
        () => {
          const a: any = document.querySelector('a.btn-gradient[href*="/login"]');
          if (a) {
            a.scrollIntoView({ block: "center" });
            a.click();
            return true;
          }
          return false;
        },
        false
      );
      if (clicked) log("[route] clicked login via DOM fallback from /home");
    }

    if (clicked) {
      await Promise.race([
        page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 20_000 }).catch(() => null),
        (async () => {
          const start = Date.now();
          while (Date.now() - start < 20_000) {
            const u = String(page.url?.() || "").toLowerCase();
            if (u.includes("/login")) return true;
            await sleep(200);
          }
          return false;
        })(),
      ]);
    }

    const after = String(page.url?.() || "").toLowerCase();
    log("[route] after home->login attempt url:", after);
    if (!after.includes("/login")) {
      warn("[route] home click did not reach /login -> goto /login directly");
      await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    }
    return;
  }

  if (!url.includes("/login")) {
    log("[route] not on /login -> goto /login");
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  }
}

function isLoginUrl(url: string) {
  return (url || "").toLowerCase().includes("/login");
}

async function isLoggedInNow(page: PageLike) {
  const hasLogout = await safeEvaluate<boolean>(
    page,
    () => !!document.querySelector('a[href*="/logout"], a[href*="logout"]'),
    false
  );
  if (hasLogout) return true;

  const url = String(page.url?.() || "").toLowerCase();
  if (url.includes("/login") || url.includes("/home") || url.includes("/register")) return false;

  const hasSiteSelect = await safeEvaluate<boolean>(page, () => !!document.querySelector("#site"), false);
  if (hasSiteSelect) return true;

  return false;
}

async function waitUntilLoggedIn(page: PageLike, timeout = POST_LOGIN_TIMEOUT) {
  const start = Date.now();
  const stopProgress = startProgress("Waiting until logged in (url != /login OR logout link visible)", 10_000);
  try {
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
  } finally {
    stopProgress();
  }
}

// ================= MODIFIED TURNSTILE HANDLER =================
/**
 * Waits for Cloudflare Turnstile to be solved.
 * Checks for a non‑empty token in textarea/input[name="cf-turnstile-response"]
 * Also considers the challenge solved if the token field disappears (e.g., redirect).
 * @param page Puppeteer page
 * @param timeout max wait time in ms
 * @returns true if solved, false if timeout
 */
async function waitForTurnstileSolved(page: PageLike, timeout = 180_000): Promise<boolean> {
  const start = Date.now();
  const stopProgress = startProgress("Waiting for Turnstile token (cf-turnstile-response)", 10_000);

  // Ensure the button is visible (helps in headless)
  await safeEvaluate<void>(
    page,
    () => {
      const btn: any = document.querySelector("#login");
      if (btn) btn.scrollIntoView({ block: "center", inline: "center" });
      window.scrollBy(0, 200);
    },
    undefined as any
  );

  try {
    while (Date.now() - start < timeout) {
      // Check if the token field exists and has a value
      const solved = await safeEvaluate<boolean>(
        page,
        () => {
          // Look for the hidden token field (textarea or input)
          const tokenField =
            document.querySelector<HTMLTextAreaElement>('textarea[name="cf-turnstile-response"]') ||
            document.querySelector<HTMLInputElement>('input[name="cf-turnstile-response"]');
          if (tokenField && tokenField.value.trim().length > 0) {
            return true; // token present → solved
          }

          // If the token field itself is gone, the challenge may have been removed (e.g., redirect)
          if (!tokenField) {
            // Additionally check if the page no longer contains the typical Turnstile container
            const turnstileContainer = document.querySelector('.cf-turnstile, [class*="turnstile"]');
            if (!turnstileContainer) return true; // no token field and no container → probably solved
          }

          return false;
        },
        false
      );

      if (solved) {
        log("[Turnstile] detected solved (token present or challenge removed).");
        return true;
      }

      await sleep(500);
    }

    warn(`[Turnstile] not solved within ${timeout}ms.`);
    await dump(page, "turnstile_timeout");
    return false;
  } finally {
    stopProgress();
  }
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
    log("[captcha] Turnstile detected on antrean page, waiting solve...");
    const solved = await waitForTurnstileSolved(page, timeout);
    if (!solved) warn("[captcha] not solved within timeout. Proceeding anyway (may fail).");
    else log("[captcha] solved.");
    return;
  }

  // Legacy captcha check (reCAPTCHA etc.) – unchanged
  const checkboxSelectors = [
    'input[type="checkbox"][class*="captcha"]',
    "#captcha",
    ".g-recaptcha",
    'iframe[src*="recaptcha"]',
  ];

  for (const sel of checkboxSelectors) {
    const element = await page.$(sel).catch(() => null);
    if (element) {
      log(`[captcha] element found (${sel}). Attempting click...`);
      try {
        await element.click();
        await sleep(1000);
        log("[captcha] checkbox clicked.");
      } catch (e: any) {
        warn(`[captcha] failed to click checkbox: ${e?.message || e}`);
      }
      return;
    }
  }

  log("[captcha] no captcha element detected on antrean page.");
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
  log("[antrean] ensure on /antrean");
  if (!String(page.url?.() || "").toLowerCase().includes("/antrean")) {
    await page.goto(ANTREAN_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  }

  log("[antrean] wait #site");
  await page.waitForSelector("#site", { timeout: 20_000 });

  const options = await getSiteOptions(page);
  if (!options.length) {
    errorLog("No site options found.");
    await dump(page, "no_site_options");
    return { ok: false as const, reason: "no_site_options" };
  }

  const selRes = await selectSiteRobust(page, { value: TARGET_SITE_VALUE, label: TARGET_SITE_LABEL });

  if (!selRes.ok) {
    errorLog("Failed selecting site:", selRes.reason);
    log("Available options sample:", options.slice(0, 10));
    await dump(page, "select_site_failed");
    return { ok: false as const, reason: "select_site_failed", details: selRes };
  }

  log(`[ok] Selected site: ${selRes.chosen.value} - ${selRes.chosen.text}`);
  await sleep(250);

  log(`[antrean] click "Tampilkan Butik"`);
  const clicked = await clickTampilkanButikByText(page);
  if (!clicked) {
    errorLog(`Could not click "Tampilkan Butik" button.`);
    await dump(page, "click_tampilkan_failed");
    return { ok: false as const, reason: "click_tampilkan_failed" };
  }

  log("[antrean] wait result ready (Sisa/form)...");
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

  log("===== RESULT =====");
  log(`Butik: ${selRes.chosen.text}`);
  log(`Sisa : ${sisa}`);

  // ✅ LOGIC UNCHANGED BELOW
  if (Number(sisa) > 0) {
    log("🟡 sisa > 0 -> select wakda then handle captcha and click Ambil Antrean...");

    await page.waitForSelector("#wakda", { timeout: 20_000 });

    const wakdaRes = await selectFirstWakdaOption(page, { skipZeroSlots: false });
    if (!wakdaRes.ok) {
      errorLog("Failed selecting wakda:", wakdaRes.reason);
      await dump(page, "select_wakda_failed");
      return {
        ok: true as const,
        site: selRes.chosen,
        sisa,
        auto: { step: "select_wakda", ...wakdaRes },
      };
    }

    log(`✅ wakda selected: ${wakdaRes.chosen.value} - ${wakdaRes.chosen.text}`);
    await sleep(250);

    await waitForCaptchaIfPresent(page);

    const ambilClicked = await clickAmbilAntrean(page);
    if (!ambilClicked) {
      errorLog(`Could not click "Ambil Antrean".`);
      await dump(page, "click_ambil_failed");
      return { ok: true as const, site: selRes.chosen, sisa, auto: { ok: false, step: "click_ambil" } };
    }

    log("✅ Clicked Ambil Antrean.");
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

// ================= LOGIN (single attempt) =================
async function performLoginOnce(page: PageLike) {
  log(`[route] ensuring we are on /login entry (handles /home fallback)...`);
  await ensureOnLoginPageEntry(page);

if (!(await waitForChallengeAndLoginDOM(page, 1_000))) {
    errorLog("Login DOM not found within timeout (challenge may not have been solved).");
    await dump(page, "login_dom_not_found_after_challenge");
    return { ok: false as const, reason: "challenge_not_solved" };
  }
  log("✅ Login DOM detected after challenge.");

  log("[login] fill username");
  await fillInputRobust(page, "#username", USERNAME, { delay: 20 });
  await sleep(150);

  log("[login] fill password");
  await fillInputRobust(page, "#password", PASSWORD, { delay: 20 });
  await sleep(150);

  const mathLabel = await page.$eval('label[for="aritmetika"]', (el: any) => el.innerText).catch(() => "");
  const mathAnswer = solveMath(mathLabel);
  log("[login] math label:", mathLabel);
  log("[login] math ans  :", mathAnswer);

  log("[login] fill aritmetika");
  await fillInputRobust(page, "#aritmetika", mathAnswer, { delay: 10, verify: true });
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

  log("[login] wait turnstile token...");
  const tsSolved = await waitForTurnstileSolved(page, 180_000);
  if (!tsSolved) {
    warn("Turnstile token not detected within 180s.");
    await dump(page, "turnstile_not_detected");
  } else {
    log("✅ Turnstile solved detected (token filled).");
  }

  await page.waitForSelector("#login", { timeout: 10_000, visible: true });
  await safeEvaluate<void>(
    page,
    () => (document.querySelector("#login") as any)?.scrollIntoView({ block: "center" }),
    undefined as any
  );
  await sleep(200);

  // ✅ Pre-login guard (unchanged)
  const guard = await ensureLoginInputsCorrect(page, { attempts: 3 });
  if (!guard.ok) {
    errorLog("Pre-login guard failed: inputs still not correct after retries.");
    await dump(page, "prelogin_guard_failed");
    return { ok: false as const, reason: "prelogin_guard_failed" };
  }

  log("[login] clicking login...");
  try {
    await page.click("#login");
  } catch {
    await safeEvaluate<void>(page, () => (document.querySelector("#login") as any)?.click(), undefined as any);
  }

  log("[login] wait navigation...");
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
    errorLog("Login did not complete (still on /login or no logout link).");
    await dump(page, "login_not_completed");
    return { ok: false as const, reason: "login_not_completed" };
  }

  log("✅ Logged in.");
  await dump(page, "logged_in");
  return { ok: true as const };
}

// ================= MAIN =================
(async () => {
  log("Launching undetectable browser...");
  log("Config:", {
    MAX_LOGIN_ATTEMPTS,
    POST_LOGIN_TIMEOUT,
    OUT_DIR,
    KEEP_BROWSER_OPEN,
    HEADLESS,               // show the headless setting
    userProvided: {
      LM_USER: !!process.env.LM_USER,
      LM_PASS: !!process.env.LM_PASS,
    },
  });

  const { browser, page }: { browser: BrowserLike; page: PageLike } = await connect({
    headless: HEADLESS,      // use environment variable
    turnstile: true,         // keep Turnstile solving enabled
    defaultViewport: null,
    args: HEADLESS
      ? [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",  // Helps in Docker with limited /dev/shm
          "--disable-gpu",             // Often needed in headless environments
          "--window-size=1366,768"
        ]
      : ["--start-maximized", "--window-position=0,0"],
  });

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

  log("[viewport]", screen);
  let quitBrowser = true;

  try {
    let attempts = 0;
    while (!(await isLoggedInNow(page))) {
      attempts++;
      log(`🔁 Login attempt ${attempts}/${MAX_LOGIN_ATTEMPTS}`);

      const res = await performLoginOnce(page);
      if (res.ok) break;

      if (attempts >= MAX_LOGIN_ATTEMPTS) {
        errorLog(`Exceeded MAX_LOGIN_ATTEMPTS=${MAX_LOGIN_ATTEMPTS}. Stopping gracefully.`);
        await dump(page, "max_login_attempts_reached");

        if (KEEP_BROWSER_OPEN) {
          quitBrowser = false;
          log("Browser will stay open for inspection. Press Ctrl+C to exit.");
          await new Promise<void>(() => {});
        }
        return;
      }

      await sleep(1500);
    }

    log("➡️ Redirecting directly to /antrean...");
    await page.goto(ANTREAN_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });

    const cur = String(page.url?.() || "").toLowerCase();
    if (cur.includes("/home") || cur.includes("/login")) {
      warn(`[auth] bounced to ${cur} -> running login flow now...`);
      const res = await performLoginOnce(page);
      if (!res.ok) throw new Error("Login failed after antrean redirect");
      await page.goto(ANTREAN_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    }

    await page.waitForSelector("#site", { timeout: 20_000 });
    log("✅ /antrean loaded directly.");

    const result = await viewSerpongOnce(page);

    log("✅ Final Result:");
    log(JSON.stringify(result, null, 2));

    if (KEEP_BROWSER_OPEN) {
      quitBrowser = false;
      log("Browser will stay open. Press Ctrl+C to exit.");
      await new Promise<void>(() => {});
    }
  } catch (e: any) {
    errorLog("Fatal error:", e?.message || e);
    try {
      await dump(page, "fatal_error");
    } catch {}
    quitBrowser = false;
    log("Keeping browser open for inspection. Press Ctrl+C to exit.");
    await new Promise<void>(() => {});
  } finally {
    if (quitBrowser) await browser.close();
  }
})();
