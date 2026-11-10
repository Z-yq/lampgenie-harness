// mermaid.run({nodes}) 行为探针(临时,跑完即删;不入测试面)
const http = require("node:http");
const fs = require("node:fs");
const { chromium } = require("playwright-core");
const ASSET = require("node:path").resolve(__dirname, "../../src/assets/mermaid.min.js");
(async () => {
  const b = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox"] });
  const p = await b.newPage();
  const errs = [];
  p.on("pageerror", (e) => errs.push(String(e).slice(0, 100)));
  await p.goto("about:blank");
  await p.addScriptTag({ path: ASSET });
  const r = await p.evaluate(async () => {
    const out = {};
    const mm = window.mermaid;
    out.hasMermaid = !!mm;
    out.runType = mm ? typeof mm.run : "none";
    out.renderType = mm ? typeof mm.render : "none";
    if (mm && mm.initialize) { try { mm.initialize({ startOnLoad: false, theme: "dark", suppressErrorReporting: true }); out.initOk = true; } catch (e) { out.initErr = String(e).slice(0, 80); } }
    if (mm && mm.run) {
      try {
        const d = document.createElement("div"); d.textContent = "this is @@@ not [valid (((("; document.body.appendChild(d);
        await mm.run({ nodes: [d] });
        out.badThrew = false;
        out.badHasErrorNode = !!d.querySelector(".error-icon,.error-text,svg");
        out.badSvg = !!d.querySelector("svg");
        out.badText = (d.textContent || "").slice(0, 50);
        out.badChildNodes = d.childNodes.length;
      } catch (e) { out.badThrew = true; out.badErr = String(e).slice(0, 120); }
      try {
        const d2 = document.createElement("div"); d2.textContent = "graph TD" + String.fromCharCode(10) + " A-->B"; document.body.appendChild(d2);
        await mm.run({ nodes: [d2] });
        out.goodSvg = !!d2.querySelector("svg");
      } catch (e) { out.goodErr = String(e).slice(0, 120); }
    }
    if (mm && mm.render) {
      try { const o = await mm.render("probeGood", "graph TD" + String.fromCharCode(10) + " A-->B"); out.renderGood = !!(o && o.svg); }
      catch (e) { out.renderGoodErr = String(e).slice(0, 120); }
      try { await mm.render("probeBad", "this is @@@ not [valid (((("); out.renderBadThrew = false; }
      catch (e) { out.renderBadThrew = true; out.renderBadErr = String(e).slice(0, 80); }
    }
    return out;
  }).catch((e) => ({ evalErr: String(e).slice(0, 200) }));
  console.log(JSON.stringify(r));
  console.log("pageerrors=" + errs.length + (errs.length ? " | " + errs.join(" | ").slice(0, 200) : ""));
  await b.close();
  process.exit(0);
})().catch((e) => { console.error("CRASH " + String(e).slice(0, 200)); process.exit(1); });
