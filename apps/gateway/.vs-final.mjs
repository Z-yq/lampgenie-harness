const { chromium } = await import("playwright-core");
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 120)));

// ===== Shot 1: 全局概览(工作区+companion+回底钮) =====
await page.goto("http://127.0.0.1:7700/", { waitUntil: "load" });
await page.waitForTimeout(3500);
await page.evaluate(() => { const r = [...document.querySelectorAll(".t-row[data-sid]")][0]; r?.click(); });
await page.waitForTimeout(3000);
// 滚到中部让回底钮出现
await page.evaluate(() => { const vt = document.getElementById("view-tasks"); if (vt) vt.scrollTop = 50; });
await page.waitForTimeout(600);
await page.screenshot({ path: "/tmp/final-1-overview.png" });

// ===== Shot 2: 选中会话内容(顶对齐+压缩边界+消息流) =====
await page.evaluate(() => { const vt = document.getElementById("view-tasks"); if (vt) vt.scrollTop = 0; });
await page.waitForTimeout(500);
await page.screenshot({ path: "/tmp/final-2-session.png", clip: { x: 280, y: 0, width: 1000, height: 900 } });

// ===== Shot 3: 模型管理页(1M 徽标+模型行+添加控件) =====
await page.evaluate(() => { document.getElementById("uGear")?.click(); });
await page.waitForTimeout(800);
await page.evaluate(() => { const it = document.querySelector('[data-sec="model"]') || [...document.querySelectorAll(".set-nitem")].find((x) => /模型/.test(x.textContent || "")); it?.click(); });
await page.waitForTimeout(1500);
await page.evaluate(() => { const box = document.querySelector(".prov-models"); const row = [...document.querySelectorAll(".pv-mrow")].find((x) => /deepseek-v4\.1-flash/.test(x.textContent || "")); if (box && row) box.scrollTop = row.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - 60; });
await page.waitForTimeout(400);
await page.screenshot({ path: "/tmp/final-3-models.png", clip: { x: 270, y: 0, width: 900, height: 900 } });

// ===== Shot 4: 容量看板展开 =====
await page.evaluate(() => { document.getElementById("uGear")?.click(); });
await page.waitForTimeout(500);
await page.evaluate(() => openSession("cw-demo2"));
await page.waitForTimeout(4000);
await page.click("#sw-bar").catch(() => {});
await page.waitForTimeout(600);
await page.screenshot({ path: "/tmp/final-4-capacity.png", clip: { x: 700, y: 0, width: 740, height: 620 } });

console.log("ERRORS:", errors.length);
console.log("SHOTS:", ["final-1-overview", "final-2-session", "final-3-models", "final-4-capacity"].join(", "));
await browser.close();
