
import express from "express";
import crypto from "node:crypto";
import { google } from "googleapis";

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================================
// CONFIGURATION
// ============================================================

const SHOPIFY_STORE = process.env.SHOPIFY_STORE;
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET;

const SHOPIFY_API_VERSION = "2026-10";
const WEBHOOK_URL =
  "https://orders-to-sheet.onrender.com/webhooks/orders-fulfilled";

const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID;
const GOOGLE_SHEET_TAB = process.env.GOOGLE_SHEET_TAB || "Sheet1";
const GOOGLE_SERVICE_ACCOUNT_EMAIL =
  process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
const GOOGLE_PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY
  ?.replace(/^["']|["']$/g, "")
  .replace(/\\n/g, "\n");

const REQUEST_TIMEOUT_MS = 20000;

const REQUIRED_ENV = [
  "SHOPIFY_STORE",
  "SHOPIFY_ACCESS_TOKEN",
  "SHOPIFY_API_SECRET",
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

const escapedTab = GOOGLE_SHEET_TAB.replace(/'/g, "''");
const SHEET_RANGE = `'${escapedTab}'!A:E`;
const ORDER_NUMBER_RANGE = `'${escapedTab}'!B:B`;

// ============================================================
// VERIFY SHOPIFY WEBHOOK SIGNATURE
// ============================================================

function verifyShopifyWebhook(rawBody, providedHmac) {
  if (!providedHmac || !Buffer.isBuffer(rawBody)) {
    return false;
  }

  const calculatedHmac = crypto
    .createHmac("sha256", SHOPIFY_API_SECRET)
    .update(rawBody)
    .digest("base64");

  const expected = Buffer.from(calculatedHmac, "utf8");
  const received = Buffer.from(providedHmac, "utf8");

  return (
    expected.length === received.length &&
    crypto.timingSafeEqual(expected, received)
  );
}

// ============================================================
// REGISTER WEBHOOK WITH SHOPIFY
// ============================================================


async function ensureWebhookRegistered() {
  const url =
    `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;

  console.log("Checking Shopify webhook registration through GraphQL...");

  const query = `
    query {
      webhookSubscriptions(first: 250) {
        nodes {
          id
          topic
          uri
        }
      }
    }
  `;

  async function shopifyGraphQL(query, variables = {}) {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    const result = await response.json();

    if (!response.ok || result.errors?.length) {
      throw new Error(
        `Shopify GraphQL error: ${JSON.stringify(
          result.errors || result
        )}`
      );
    }

    return result.data;
  }

  const data = await shopifyGraphQL(query);

  const existing = data.webhookSubscriptions.nodes.find(
    (webhook) =>
      webhook.topic === "ORDERS_FULFILLED" &&
      webhook.uri === WEBHOOK_URL
  );

  if (existing) {
    console.log(
      `Fulfillment webhook already registered. ID: ${existing.id}`
    );
    return;
  }

  console.log("Registering ORDERS_FULFILLED webhook...");

  const mutation = `
    mutation CreateFulfillmentWebhook(
      $topic: WebhookSubscriptionTopic!,
      $webhookSubscription: WebhookSubscriptionInput!
    ) {
      webhookSubscriptionCreate(
        topic: $topic,
        webhookSubscription: $webhookSubscription
      ) {
        webhookSubscription {
          id
          topic
          uri
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const result = await shopifyGraphQL(mutation, {
    topic: "ORDERS_FULFILLED",
    webhookSubscription: {
      uri: WEBHOOK_URL,
      format: "JSON",
    },
  });

  const created = result.webhookSubscriptionCreate;
  const errors = created.userErrors || [];

  if (errors.length) {
    throw new Error(
      `Shopify could not register the webhook: ${JSON.stringify(errors)}`
    );
  }

  console.log(
    `Webhook registered successfully. ID: ${
      created.webhookSubscription?.id || "unknown"
    }`
  );
}


// ============================================================
// FULFILLMENT DATE
// ============================================================

function getFulfillmentDate(order, triggeredAt) {
  const dates = (order.fulfillments || [])
    .map((fulfillment) => new Date(fulfillment.created_at))
    .filter((date) => !Number.isNaN(date.getTime()));

  let date;

  if (dates.length) {
    date = new Date(
      Math.max(...dates.map((item) => item.getTime()))
    );
  } else {
    date = new Date(
      triggeredAt || order.updated_at || order.created_at
    );
  }

  return date.toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    month: "2-digit",
    day: "2-digit",
    year: "numeric",
  });
}

// ============================================================
// PROCESS A FULFILLED ORDER
// ============================================================

async function processFulfilledOrder(order, triggeredAt) {
  const orderNumber = String(order.name || "").trim();

  if (!orderNumber) {
    throw new Error("Webhook order has no order number.");
  }

  // Confirm the order is fully fulfilled.
  if (order.fulfillment_status !== "fulfilled") {
    console.log(
      `Ignoring ${orderNumber}: fulfillment status is ${order.fulfillment_status ?? "null"}.`
    );
    return;
  }

  console.log(`Checking spreadsheet for ${orderNumber}...`);

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

  if (existingOrderNumbers.has(orderNumber)) {
    console.log(`${orderNumber} is already in the sheet; skipping.`);
    return;
  }

  const total = Number(order.total_price);

  if (!Number.isFinite(total) || total < 0) {
    throw new Error(`Invalid total for ${orderNumber}.`);
  }

  const totalCents = Math.round(total * 100);
  const tenPercentCents = Math.round(totalCents * 0.1);

  const row = [
    getFulfillmentDate(order, triggeredAt),
    orderNumber,
    "wonder portal",
    totalCents / 100,
    tenPercentCents / 100,
  ];

  await sheets.spreadsheets.values.append(
    {
      spreadsheetId: GOOGLE_SHEET_ID,
      range: SHEET_RANGE,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: {
        values: [row],
      },
    },
    {
      timeout: REQUEST_TIMEOUT_MS,
    }
  );

  console.log(`Successfully added ${orderNumber} to Google Sheets.`);
}

// ============================================================
// WEBHOOK RECEIVER
// IMPORTANT: Keep the raw-body parser on this route.
// ============================================================

let webhookProcessing = Promise.resolve();

app.post(
  "/webhooks/orders-fulfilled",
  express.raw({ type: "application/json", limit: "2mb" }),
  async (req, res) => {
    const providedHmac = req.get("X-Shopify-Hmac-SHA256");

    if (!verifyShopifyWebhook(req.body, providedHmac)) {
      console.warn("Rejected webhook: invalid HMAC signature.");
      return res.status(401).send("Invalid webhook signature.");
    }

    const topic = req.get("X-Shopify-Topic");
    const shopDomain = req.get("X-Shopify-Shop-Domain");
    const webhookId = req.get("X-Shopify-Webhook-Id");

    if (topic !== "orders/fulfilled") {
      return res.status(400).send("Unexpected webhook topic.");
    }

    if (
      shopDomain &&
      shopDomain.toLowerCase() !== SHOPIFY_STORE.toLowerCase()
    ) {
      return res.status(401).send("Unexpected Shopify shop.");
    }

    let order;

    try {
      order = JSON.parse(req.body.toString("utf8"));
    } catch {
      return res.status(400).send("Invalid JSON payload.");
    }

    console.log(
      `Received orders/fulfilled webhook. Delivery ID: ${webhookId || "not provided"}`
    );

    const triggeredAt = req.get("X-Shopify-Triggered-At");

    // Serialize work so simultaneous deliveries do not race while
    // checking for an existing order number in Google Sheets.
    const task = webhookProcessing.then(() =>
      processFulfilledOrder(order, triggeredAt)
    );

    webhookProcessing = task.catch(() => {});

    try {
      await task;
      return res.status(200).send("Webhook processed.");
    } catch (error) {
      console.error(
        "Webhook processing failed:",
        error.message || error
      );
      return res.status(500).send("Webhook processing failed.");
    }
  }
);

// ============================================================
// HEALTH CHECK
// ============================================================

app.get("/", (req, res) => {
  res.status(200).send("Shopify fulfillment webhook receiver is running.");
});

// ============================================================
// START SERVER AND REGISTER WEBHOOK
// ============================================================

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Shopify webhook app running on port ${PORT}`);

  ensureWebhookRegistered().catch((error) => {
    console.error(
      "Webhook registration failed:",
      error.message || error
    );
  });
});
