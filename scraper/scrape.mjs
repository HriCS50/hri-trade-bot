// Scrapes India's official TIA Portal (Department of Commerce) "Trade Watch - Country"
// dashboard for every trading partner and writes the results to ../data/countries.json
//
// WHY A HEADLESS BROWSER: the TIA portal is a JS-rendered dashboard with no public/
// documented JSON API. Selecting a country happens via an on-page filter panel, so we
// drive a real (headless) browser instead of guessing at hidden endpoints.
//
// NOTE ON SELECTORS: the click targets below ("Countries" filter, country name, "Submit")
// are based on the page's rendered text/structure as observed in Aug 2026. Government
// portals occasionally tweak their markup. If a run starts failing for most/all countries,
// see the "Debugging" section in the README - it walks through re-inspecting the page and
// updating the selectors here.

import { chromium } from "playwright";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const BASE_URL = "https://trade-analytics.commerce.gov.in/public/country";
const OUT_PATH = path.resolve("../data/countries.json");
const DEBUG_DIR = path.resolve("./debug-screenshots");
const NAV_TIMEOUT_MS = 45_000;
const PER_COUNTRY_DELAY_MS = 1200; // be polite to a government server

// Full list of partner countries as listed on the portal's own filter panel.
// ("World" and "Other Countries" are aggregate entries the portal itself offers.)
const COUNTRIES = [
  "Afghanistan","Albania","Algeria","American Samoa","Andorra","Angola","Anguilla",
  "Antigua and Barbuda","Argentina","Armenia","Aruba","Australia","Austria","Azerbaijan",
  "Bahamas","Bahrain","Bangladesh","Barbados","Belarus","Belgium","Belize","Benin",
  "Bermuda","Bhutan","Bolivia","Bosnia and Herz.","Botswana","Brazil",
  "British Indian Ocean Territory","Brunei","Bulgaria","Burkina Faso","Burundi",
  "Cambodia","Cameroon","Canada","Cape Verde","Cayman Is.","Central African Republic",
  "Chad","Chile","China","Christmas Island","Cocos (Keeling) Islands","Colombia",
  "Comoros","Congo","Cook Islands","Costa Rica","Cote D' Ivoire","Croatia","Cuba",
  "Curacao","Cyprus","Czech Republic","Dem. Rep. Congo","Denmark","Djibouti","Dominica",
  "Dominican Rep.","Ecuador","Egypt","El Salvador","Eq. Guinea","Eritrea","Estonia",
  "Ethiopia","Falkland Islands","Faroe Islands","Fiji","Finland","France",
  "French Guiana","French Polynesia","Gabon","Gambia","Georgia","Germany","Ghana",
  "Gibraltar","Greece","Greenland","Grenada","Guadeloupe","Guam","Guatemala","Guernsey",
  "Guinea","Guinea-Bissau","Guyana","Haiti","Holy See (Vatican City State)","Honduras",
  "Hong Kong","Hungary","Iceland","Indonesia","Iran","Iraq","Ireland","Israel","Italy",
  "Jamaica","Japan","Jersey","Jordan","Kazakhstan","Kenya","Kiribati","Korea (north)",
  "Korea (south)","Kuwait","Kyrgyzstan","Lao PDR","Latvia","Lebanon","Lesotho","Liberia",
  "Libya","Liechtenstein","Lithuania","Luxembourg","Macao, China","Madagascar","Malawi",
  "Malaysia","Maldives","Mali","Malta","Marshall Islands","Martinique","Mauritania",
  "Mauritius","Mayotte","Mexico","Micronesia, Federated States of","Moldova","Monaco",
  "Mongolia","Montenegro","Montserrat","Morocco","Mozambique","Myanmar","Namibia",
  "Nauru","Nepal","Netherlands","Netherlands Antilles","New Caledonia","New Zealand",
  "Nicaragua","Niger","Nigeria","Niue Island","N. Mariana Is.","Norfolk Island",
  "North Macedonia","Norway","Oman","Other Countries","Pakistan","Palestine","Panama",
  "Papua New Guinea","Paraguay","Peru","Philippines","Pitcairn Islands","Poland",
  "Portugal","Puerto Rico","Qatar","Republic of Palau","Reunion","Romania","Russia",
  "Rwanda","Saint Helena","Saint Kitts and Nevis","Saint Lucia",
  "Saint Pierre and Miquelon","Saint Vincent and Grenadines","Samoa","San Marino",
  "Sao Tome and Principe","Saudi Arabia","Senegal","Serbia","Seychelles","Sierra Leone",
  "Singapore","Sint Maarten","Slovakia","Slovenia","Solomon Is.","Somalia",
  "South Africa","Spain","Sri Lanka","S. Sudan","Sudan","Suriname","Svalbard",
  "Swaziland","Sweden","Switzerland","Syrian Arab Republic (Syria)","Taiwan",
  "Tajikistan","Thailand","Timor-Leste","Togo","Tokelau","Tonga",
  "Trinidad and Tobago","Tunisia","Turkey","Turkmenistan","Turks and Caicos Islands",
  "Tuvalu","Uganda","Ukraine","United Arab Emirates","United Kingdom",
  "United Republic of Tanzania","United States of America","Uruguay","Uzbekistan",
  "Vanuatu","Venezuela","Vietnam","Virgin Islands (UK)","Virgin Islands (US)",
  "Wallis and Futuna","Western Sahara","World","Yemen","Zambia","Zimbabwe",
];

// Only scrape a subset while testing (set COUNTRIES_LIMIT env var), e.g.:
//   COUNTRIES_LIMIT=5 npm run scrape
const LIMIT = process.env.COUNTRIES_LIMIT ? Number(process.env.COUNTRIES_LIMIT) : COUNTRIES.length;

function numberAfter(text, label) {
  const idx = text.indexOf(label);
  if (idx === -1) return null;
  const after = text.slice(idx + label.length);
  const m = after.match(/-?[\d,]+\.?\d*/);
  return m ? parseFloat(m[0].replace(/,/g, "")) : null;
}

function commodityAfter(text, label) {
  const idx = text.indexOf(label);
  if (idx === -1) return null;
  const after = text.slice(idx + label.length).trim();
  const m = after.match(/^([\s\S]*?)([\d,]+\.\d+)/);
  if (!m) return null;
  return { name: m[1].trim().replace(/^\W+/, ""), value: parseFloat(m[2].replace(/,/g, "")) };
}

function parseCountryPage(bodyText, countryName) {
  const record = {
    country: countryName,
    rankInExport: numberAfter(bodyText, "Rank in export"),
    rankInImport: numberAfter(bodyText, "Rank in import"),
    totalExportUSDMillion: numberAfter(bodyText, "Total Export (USD million)"),
    totalImportUSDMillion: numberAfter(bodyText, "Total import (USD million)"),
    tradeBalanceUSDMillion: numberAfter(bodyText, "Trade balance (USD million)"),
    exportGrowthPercent: numberAfter(bodyText, "Export growth (%)"),
    shareInIndiaImportPercent: numberAfter(bodyText, "Share in India (Import)%"),
    shareInIndiaExportPercent: numberAfter(bodyText, "Share in India (Export)%"),
  };
  const topExport = commodityAfter(bodyText, "Top commodity of export (USD million)");
  const topImport = commodityAfter(bodyText, "Top imported commodity (USD million)");
  if (topExport) {
    record.topExportCommodity = topExport.name;
    record.topExportCommodityValueUSDMillion = topExport.value;
  }
  if (topImport) {
    record.topImportCommodity = topImport.name;
    record.topImportCommodityValueUSDMillion = topImport.value;
  }
  return record;
}

// Returns true if the record looks usable (has at least the core totals).
function isRecordUseful(record) {
  return record.totalExportUSDMillion !== null && record.totalImportUSDMillion !== null;
}

// Tries a couple of plausible interaction strategies, since I couldn't click
// through the live site myself to confirm which one the portal actually uses.
async function selectCountryAndSubmit(page, countryName) {
  const strategies = [clickBasedSelection, nativeSelectSelection];
  let lastError;

  for (const strategy of strategies) {
    try {
      await strategy(page, countryName);
      return; // first strategy that doesn't throw wins
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(
    `All selection strategies failed for "${countryName}". Last error: ${lastError?.message}`
  );
}

// Strategy 1: the portal renders the country list as clickable text inside an
// expandable "Countries" filter panel (this is what the page's structure looked
// like when inspected in Aug 2026).
async function clickBasedSelection(page, countryName) {
  const countriesToggle = page.locator('a:has-text("Countries")').first();
  await countriesToggle.click({ timeout: 5000 });
  await page.waitForSelector("text=Select Country", { timeout: 8000 });

  const option = page.getByText(countryName, { exact: true }).first();
  await option.scrollIntoViewIfNeeded({ timeout: 5000 });
  await option.click({ timeout: 5000 });

  await clickSubmit(page);
}

// Strategy 2: fallback in case the country list is (or becomes) a plain native
// <select> element instead of a custom clickable list.
async function nativeSelectSelection(page, countryName) {
  const select = page.locator("select").filter({ hasText: "Afghanistan" }).first();
  await select.selectOption({ label: countryName }, { timeout: 5000 });
  await clickSubmit(page);
}

async function clickSubmit(page) {
  // Try a few likely ways "Submit" might be implemented.
  const candidates = [
    () => page.getByRole("button", { name: "Submit", exact: false }).first(),
    () => page.locator('text=Submit').first(),
    () => page.locator('input[type="submit"]').first(),
  ];
  let clicked = false;
  for (const getLocator of candidates) {
    try {
      await getLocator().click({ timeout: 3000 });
      clicked = true;
      break;
    } catch {
      // try next candidate
    }
  }
  if (!clicked) throw new Error('Could not find a "Submit" control to click');

  await page.waitForLoadState("networkidle", { timeout: NAV_TIMEOUT_MS }).catch(() => {});
  await page.waitForTimeout(1000);
}

async function scrapeOne(page, countryName) {
  await selectCountryAndSubmit(page, countryName);
  const bodyText = await page.locator("body").innerText();
  return parseCountryPage(bodyText, countryName);
}

// USA is a good canary: it's the default country the portal shows on first load,
// and we already have its real, human-verified numbers (see data/countries.json's
// seed record) to sanity-check against. If this fails, the site's markup has
// likely changed and there's no point burning time/screenshots on 220 countries.
async function verifyScraperWorks(page) {
  console.log("Sanity check: scraping United States of America before the full run...");
  await page.goto(BASE_URL, { waitUntil: "networkidle" });
  const record = await scrapeOne(page, "United States of America");

  if (!isRecordUseful(record)) {
    console.error(
      "\nSanity check FAILED: could not read USA's trade totals off the page.\n" +
      "This almost certainly means the portal's markup changed and the scraper's\n" +
      "selectors need updating - see the README's Debugging section.\n" +
      `Parsed record: ${JSON.stringify(record)}`
    );
    await page.screenshot({ path: path.join(DEBUG_DIR, "sanity_check_failure.png") }).catch(() => {});
    return false;
  }

  console.log(
    `Sanity check OK - got export $${record.totalExportUSDMillion}M / ` +
    `import $${record.totalImportUSDMillion}M for USA. Proceeding with full run.\n`
  );
  return true;
}

async function main() {
  await mkdir(DEBUG_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: process.env.HEADLESS !== "false" });
  const page = await browser.newPage();
  page.setDefaultTimeout(NAV_TIMEOUT_MS);

  const ok = await verifyScraperWorks(page);
  if (!ok) {
    await browser.close();
    process.exitCode = 1;
    return;
  }

  const results = [];
  const failures = [];

  for (let i = 0; i < LIMIT; i++) {
    const countryName = COUNTRIES[i];
    process.stdout.write(`[${i + 1}/${LIMIT}] ${countryName} ... `);
    try {
      // Reload the base page fresh for each country - simplest way to avoid
      // stale filter-panel state carrying over between selections.
      await page.goto(BASE_URL, { waitUntil: "networkidle" });
      const record = await scrapeOne(page, countryName);
      if (isRecordUseful(record)) {
        results.push(record);
        console.log("ok");
      } else {
        failures.push(countryName);
        console.log("no data found (page structure may not have matched)");
        await page.screenshot({ path: path.join(DEBUG_DIR, `${countryName.replace(/[^\w]+/g, "_")}.png`) }).catch(() => {});
      }
    } catch (err) {
      failures.push(countryName);
      console.log(`FAILED (${err.message})`);
      await page.screenshot({ path: path.join(DEBUG_DIR, `${countryName.replace(/[^\w]+/g, "_")}_error.png`) }).catch(() => {});
    }
    await page.waitForTimeout(PER_COUNTRY_DELAY_MS);
  }

  await browser.close();

  if (results.length === 0) {
    console.error(
      "\nNo countries scraped successfully - leaving data/countries.json untouched.\n" +
      "The site's markup likely changed. Check debug-screenshots/ and the README's Debugging section."
    );
    process.exitCode = 1;
    return;
  }

  const out = {
    source: BASE_URL,
    lastUpdated: new Date().toISOString(),
    note: failures.length
      ? `Scraped ${results.length}/${LIMIT} countries. Failed: ${failures.join(", ")}`
      : `Scraped all ${results.length} countries successfully.`,
    countries: results,
  };

  await writeFile(OUT_PATH, JSON.stringify(out, null, 2) + "\n", "utf-8");
  console.log(`\nWrote ${results.length} countries to ${OUT_PATH}`);
  if (failures.length) {
    console.log(`${failures.length} countries failed: ${failures.join(", ")}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
