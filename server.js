
import express from "express";
import { google } from "googleapis";

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================================
// CONFIGURATION
// ============================================================

const SHOPIFY_STORE = process.env.SHOPIFY_STORE;
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const SHOPIFY_API_VERSION = "2026-10";

const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID;
const GOOGLE_SHEET_TAB = process.env.GOOGLE_SHEET_TAB || "Sheet1";
const GOOGLE_SERVICE_ACCOUNT_EMAIL =
  process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
const GOOGLE_PRIVATE_KEY =
  process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n");

const SYNC_INTERVAL_MS = 60 * 1000;
const REQUEST_TIMEOUT_MS = 20000;

const REQUIRED_ENV = [
  "SHOPIFY_STORE",
  "SHOPIFY_ACCESS_TOKEN",
  "GOOGLE_SHEET_ID",
  "GOOGLE_SERVICE_ACCOUNT_EMAIL",
  "GOOGLE_PRIVATE_KEY",
];

for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
}

// ============================================================
// GOOGLE SHEETS
// ============================================================

const auth = new google.auth.GoogleAuth({
  credentials: {
    client_email: GOOGLE_SERVICE_ACCOUNT_EMAIL,
    private_key: GOOGLE_PRIVATE_KEY,
  },
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const sheets = google.sheets({
  version: "v4",
  auth,
});

const SHEET_RANGE =
  `'${GOOGLE_SHEET_TAB.replace(/'/g, "''")}'!A:E`;

const ORDER_NUMBER_RANGE =
  `'${GOOGLE_SHEET_TAB.replace(/'/g, "''")}'!B:B`;

// ============================================================
// SHOPIFY FETCH
// ============================================================

async function fetchFulfilledOrders() {
  console.log("Connecting to Shopify...");

  const orders = [];

  let nextUrl =
    `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}/orders.json` +
    "?status=any&fulfillment_status=shipped&limit=250";

  while (nextUrl) {
    console.log("Requesting orders from Shopify...");

    const response = await fetch(nextUrl, {
      headers: {
        "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    console.log(`Shopify responded with status ${response.status}`);

    if (!response.ok) {
      const errorText = await response.text();

      throw new Error(
        `Shopify API error ${response.status}: ${errorText}`
      );
    }

    const data = await response.json();
    const pageOrders = data.orders || [];

    console.log(
      `Retrieved ${pageOrders.length} order(s) from this page.`
    );

    orders.push(...pageOrders);

    const linkHeader = response.headers.get("link");
    const nextMatch = linkHeader?.match(
      /<([^>]+)>;\s*rel="next"/
    );

    nextUrl = nextMatch ? nextMatch[1] : null;
  }

  console.log(
    `Shopify retrieval complete. Total orders returned: ${orders.length}`
  );

  return orders;
}

// ============================================================
// GOOGLE SHEETS SYNC
// ============================================================

async function syncOrders() {
  console.log("Starting Shopify order sync:", new Date().toISOString());

  const orders = await fetchFulfilledOrders();

  console.log("Shopify fetch finished; connecting to Google Sheets...");
  console.log("Checking existing order numbers in Google Sheets...");

  const existingResponse = await sheets.spreadsheets.values.get(
    {
      spreadsheetId: GOOGLE_SHEET_ID,
      range: ORDER_NUMBER_RANGE,
    },
    {
      timeout: REQUEST_TIMEOUT_MS,
    }
  );

  const existingOrderNumbers = new Set(
    (existingResponse.data.values || [])
      .flat()
      .map((value) => String(value).trim())
      .filter(Boolean)
  );

  console.log(
    `Google Sheets connection successful. Existing order numbers: ${existingOrderNumbers.size}`
  );

  const rows = [];

  for (const order of orders) {
    // Only process fully fulfilled orders.
    if (order.fulfillment_status !== "fulfilled") {
      continue;
    }

    const orderNumber = String(order.name || "").trim();

    if (!orderNumber) {
      console.warn(`Skipping order ${order.id}: no order number.`);
      continue;
    }

    if (existingOrderNumbers.has(orderNumber)) {
      continue;
    }

    const total = Number(order.total_price);

    if (!Number.isFinite(total) || total < 0) {
      console.warn(`Skipping ${orderNumber}: invalid order total.`);
      continue;
    }

    // Use the latest fulfillment timestamp.
    const fulfillmentDates = (order.fulfillments || [])
      .map((fulfillment) => new Date(fulfillment.created_at))
      .filter((date) => !Number.isNaN(date.getTime()));

    const latestFulfillment = fulfillmentDates.length
      ? new Date(
          Math.max(
            ...fulfillmentDates.map((date) => date.getTime())
          )
        )
      : new Date(order.updated_at || order.created_at);

    const fulfillmentDate = latestFulfillment.toLocaleDateString(
      "en-US",
      {
        timeZone: "America/New_York",
        month: "2-digit",
        day: "2-digit",
        year: "numeric",
      }
    );

    // Calculate money in cents to avoid floating-point rounding errors.
    const totalCents = Math.round(total * 100);
    const tenPercentCents = Math.round(totalCents * 0.1);

    rows.push([
      fulfillmentDate,
      orderNumber,
      "wonder portal",
      totalCents / 100,
      tenPercentCents / 100,
    ]);

    // Prevent duplicates within the same sync batch.
    existingOrderNumbers.add(orderNumber);
  }

  console.log(
    `Found ${rows.length} new fulfilled order(s) to add.`
  );

  if (rows.length === 0) {
    console.log("No new fulfilled orders to add.");
    return;
  }

  console.log("Writing new rows to Google Sheets...");

  await sheets.spreadsheets.values.append(
    {
      spreadsheetId: GOOGLE_SHEET_ID,
      range: SHEET_RANGE,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: {
        values: rows,
      },
    },
    {
      timeout: REQUEST_TIMEOUT_MS,
    }
  );

  console.log(
    `Successfully added ${rows.length} order(s) to Google Sheets.`
  );
}

// ============================================================
// SAFE SYNC LOOP
// ============================================================

let syncInProgress = false;

async function runSyncSafely() {
  if (syncInProgress) {
    console.log(
      "Previous sync still running; skipping this cycle."
    );
    return;
  }

  syncInProgress = true;

  try {
    await syncOrders();
  } catch (error) {
    console.error("Order sync failed:", error.message || error);

    if (error.stack) {
      console.error(error.stack);
    }
  } finally {
    syncInProgress = false;
  }
}

// ============================================================
// SERVER
// ============================================================

app.get("/", (req, res) => {
  res.status(200).send(
    "Shopify to Google Sheets sync is running."
  );
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `Shopify to Google Sheets app running on port ${PORT}`
  );

  // Run once immediately, then every minute.
  runSyncSafely();
  setInterval(runSyncSafely, SYNC_INTERVAL_MS);
});
