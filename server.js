import express from "express";
import crypto from "node:crypto";
import { google } from "googleapis";

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================================
// CONFIGURATION
// ============================================================

// EXISTING WONDER STORE
const SHOPIFY_STORE = process.env.SHOPIFY_STORE;
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET;

// NAYA STORE - DEV DASHBOARD CREDENTIALS
const NAYA_SHOPIFY_STORE = process.env.NAYA_SHOPIFY_STORE;
const NAYA_SHOPIFY_CLIENT_ID =
  process.env.NAYA_SHOPIFY_CLIENT_ID;
const NAYA_SHOPIFY_CLIENT_SECRET =
  process.env.NAYA_SHOPIFY_CLIENT_SECRET;

const SHOPIFY_API_VERSION = "2026-10";

const WEBHOOK_URL =
  "https://orders-to-sheet.onrender.com/webhooks/orders-fulfilled";

const REQUEST_TIMEOUT_MS = 20000;

// GOOGLE SHEETS
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID;
const GOOGLE_SHEET_TAB =
  process.env.GOOGLE_SHEET_TAB || "Sheet1";

const GOOGLE_SERVICE_ACCOUNT_EMAIL =
  process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;

const GOOGLE_PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY
  ?.replace(/^["']|["']$/g, "")
  .replace(/\\n/g, "\n");

// ============================================================
// REQUIRED ENVIRONMENT VARIABLES
// ============================================================

const REQUIRED_ENV = [
  "SHOPIFY_STORE",
  "SHOPIFY_ACCESS_TOKEN",
  "SHOPIFY_API_SECRET",
  "NAYA_SHOPIFY_STORE",
  "NAYA_SHOPIFY_CLIENT_ID",
  "NAYA_SHOPIFY_CLIENT_SECRET",
  "GOOGLE_SHEET_ID",
  "GOOGLE_SERVICE_ACCOUNT_EMAIL",
  "GOOGLE_PRIVATE_KEY",
];

for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    throw new Error(
      `Missing required environment variable: ${key}`
    );
  }
}

if (
  SHOPIFY_STORE.toLowerCase() ===
  NAYA_SHOPIFY_STORE.toLowerCase()
) {
  throw new Error(
    "SHOPIFY_STORE and NAYA_SHOPIFY_STORE must be different stores."
  );
}

// ============================================================
// GOOGLE SHEETS
// ============================================================

const auth = new google.auth.GoogleAuth({
  credentials: {
    client_email: GOOGLE_SERVICE_ACCOUNT_EMAIL,
    private_key: GOOGLE_PRIVATE_KEY,
  },
  scopes: [
    "https://www.googleapis.com/auth/spreadsheets",
  ],
});

const sheets = google.sheets({
  version: "v4",
  auth,
});

const escapedTab = GOOGLE_SHEET_TAB.replace(/'/g, "''");

const SHEET_RANGE = `'${escapedTab}'!A:E`;
const ORDER_NUMBER_RANGE = `'${escapedTab}'!B:C`;

// ============================================================
// STORE CONFIGURATION
// ============================================================

const STORES = new Map([
  [
    SHOPIFY_STORE.toLowerCase(),
    {
      name: "WONDER",
      source: "wonder portal",
      webhookSecret: SHOPIFY_API_SECRET,
    },
  ],
  [
    NAYA_SHOPIFY_STORE.toLowerCase(),
    {
      name: "NAYA",
      source: "NAYA portal",
      webhookSecret: NAYA_SHOPIFY_CLIENT_SECRET,
    },
  ],
]);

// ============================================================
// NAYA ACCESS TOKEN
// AUTOMATICALLY OBTAIN AND REFRESH THE TOKEN
// ============================================================

let nayaAccessToken = null;
let nayaTokenExpiresAt = 0;
let nayaTokenRequest = null;

async function getNayaAccessToken() {
  // Reuse the cached token while it is valid.
  // Refresh one minute before its expiration.
  if (
    nayaAccessToken &&
    Date.now() < nayaTokenExpiresAt
  ) {
    return nayaAccessToken;
  }

  // Prevent simultaneous requests from requesting
  // multiple tokens at the same time.
  if (nayaTokenRequest) {
    return nayaTokenRequest;
  }

  nayaTokenRequest = (async () => {
    console.log(
      "Requesting NAYA Shopify Admin API access token..."
    );

    const tokenUrl =
      `https://${NAYA_SHOPIFY_STORE}/admin/oauth/access_token`;

    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: NAYA_SHOPIFY_CLIENT_ID,
      client_secret: NAYA_SHOPIFY_CLIENT_SECRET,
    });

    const response = await fetch(tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    let result;

    try {
      result = await response.json();
    } catch {
      throw new Error(
        `NAYA token request returned an invalid response. HTTP ${response.status}.`
      );
    }

    if (!response.ok || !result.access_token) {
      throw new Error(
        `NAYA token request failed. HTTP ${response.status}: ${
          JSON.stringify(result)
        }`
      );
    }

    nayaAccessToken = result.access_token;

    const expiresIn = Number(result.expires_in) || 86400;

    nayaTokenExpiresAt =
      Date.now() + expiresIn * 1000 - 60000;

    console.log(
      `NAYA Shopify access token obtained successfully. Expires in approximately ${Math.floor(
        expiresIn / 3600
      )} hours.`
    );

    return nayaAccessToken;
  })();

  try {
    return await nayaTokenRequest;
  } finally {
    nayaTokenRequest = null;
  }
}

// ============================================================
// VERIFY SHOPIFY WEBHOOK SIGNATURE
// ============================================================

function verifyShopifyWebhook(
  rawBody,
  providedHmac,
  webhookSecret
) {
  if (
    !providedHmac ||
    !Buffer.isBuffer(rawBody) ||
    !webhookSecret
  ) {
    return false;
  }

  const calculatedHmac = crypto
    .createHmac("sha256", webhookSecret)
    .update(rawBody)
    .digest("base64");

  const expected = Buffer.from(
    calculatedHmac,
    "utf8"
  );

  const received = Buffer.from(
    providedHmac,
    "utf8"
  );

  return (
    expected.length === received.length &&
    crypto.timingSafeEqual(expected, received)
  );
}

// ============================================================
// SHOPIFY GRAPHQL HELPER
// ============================================================

async function shopifyGraphQL(
  store,
  accessToken,
  query,
  variables = {}
) {
  const url =
    `https://${store}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": accessToken,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      query,
      variables,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  let result;

  try {
    result = await response.json();
  } catch {
    throw new Error(
      `Shopify GraphQL returned an invalid response. HTTP ${response.status}.`
    );
  }

  if (!response.ok || result.errors?.length) {
    throw new Error(
      `Shopify GraphQL error: ${JSON.stringify(
        result.errors || result
      )}`
    );
  }

  return result.data;
}

// ============================================================
// REGISTER A STORE'S FULFILLMENT WEBHOOK
// ============================================================

async function registerFulfillmentWebhook(
  store,
  accessToken,
  storeName
) {
  console.log(
    `Checking ${storeName} Shopify webhook registration through GraphQL...`
  );

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

  const data = await shopifyGraphQL(
    store,
    accessToken,
    query
  );

  const existing =
    data.webhookSubscriptions.nodes.find(
      (webhook) =>
        webhook.topic === "ORDERS_FULFILLED" &&
        webhook.uri === WEBHOOK_URL
    );

  if (existing) {
    console.log(
      `${storeName} fulfillment webhook already registered. ID: ${existing.id}`
    );

    return;
  }

  console.log(
    `Registering ${storeName} ORDERS_FULFILLED webhook...`
  );

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

  const result = await shopifyGraphQL(
    store,
    accessToken,
    mutation,
    {
      topic: "ORDERS_FULFILLED",
      webhookSubscription: {
        uri: WEBHOOK_URL,
        format: "JSON",
      },
    }
  );

  const created = result.webhookSubscriptionCreate;
  const errors = created.userErrors || [];

  if (errors.length) {
    throw new Error(
      `Shopify could not register the ${storeName} webhook: ${JSON.stringify(
        errors
      )}`
    );
  }

  console.log(
    `${storeName} webhook registered successfully. ID: ${
      created.webhookSubscription?.id || "unknown"
    }`
  );
}

// ============================================================
// REGISTER WONDER WEBHOOK
// ============================================================

async function ensureWebhookRegistered() {
  await registerFulfillmentWebhook(
    SHOPIFY_STORE,
    SHOPIFY_ACCESS_TOKEN,
    "WONDER"
  );
}

// ============================================================
// REGISTER NAYA WEBHOOK
// ============================================================

async function ensureNayaWebhookRegistered() {
  const accessToken = await getNayaAccessToken();

  await registerFulfillmentWebhook(
    NAYA_SHOPIFY_STORE,
    accessToken,
    "NAYA"
  );
}

// ============================================================
// FULFILLMENT DATE
// ============================================================

function getFulfillmentDate(order, triggeredAt) {
  const dates = (order.fulfillments || [])
    .map(
      (fulfillment) =>
        new Date(fulfillment.created_at)
    )
    .filter(
      (date) => !Number.isNaN(date.getTime())
    );

  let date;

  if (dates.length) {
    date = new Date(
      Math.max(
        ...dates.map((item) => item.getTime())
      )
    );
  } else {
    date = new Date(
      triggeredAt ||
      order.updated_at ||
      order.created_at
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

async function processFulfilledOrder(
  order,
  triggeredAt,
  storeConfig
) {
  const orderNumber = String(
    order.name || ""
  ).trim();

  if (!orderNumber) {
    throw new Error(
      "Webhook order has no order number."
    );
  }

  // Confirm the order is fully fulfilled.
  if (order.fulfillment_status !== "fulfilled") {
    console.log(
      `Ignoring ${orderNumber}: fulfillment status is ${
        order.fulfillment_status ?? "null"
      }.`
    );

    return;
  }

  console.log(
    `Checking spreadsheet for ${orderNumber} from ${storeConfig.name}...`
  );

  const existingResponse =
    await sheets.spreadsheets.values.get(
      {
        spreadsheetId: GOOGLE_SHEET_ID,
        range: ORDER_NUMBER_RANGE,
      },
      {
        timeout: REQUEST_TIMEOUT_MS,
      }
    );

  // Check BOTH order number and source.
  // This allows the same order number to exist
  // in both WONDER and NAYA.

  const alreadyExists = (
    existingResponse.data.values || []
  ).some(
    (row) =>
      String(row[0] || "").trim() === orderNumber &&
      String(row[1] || "").trim().toLowerCase() ===
        storeConfig.source.toLowerCase()
  );

  if (alreadyExists) {
    console.log(
      `${orderNumber} from ${storeConfig.name} is already in the sheet; skipping.`
    );

    return;
  }

  const total = Number(order.total_price);

  if (!Number.isFinite(total) || total < 0) {
    throw new Error(
      `Invalid total for ${orderNumber}.`
    );
  }

  const totalCents = Math.round(total * 100);

  const tenPercentCents = Math.round(
    totalCents * 0.1
  );

  const row = [
    getFulfillmentDate(order, triggeredAt),
    orderNumber,
    storeConfig.source,
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

  console.log(
    `Successfully added ${orderNumber} from ${storeConfig.name} to Google Sheets.`
  );
}

// ============================================================
// WEBHOOK RECEIVER
// KEEP THE RAW-BODY PARSER ON THIS ROUTE.
// ============================================================

let webhookProcessing = Promise.resolve();

app.post(
  "/webhooks/orders-fulfilled",
  express.raw({
    type: "application/json",
    limit: "2mb",
  }),
  async (req, res) => {
    const providedHmac = req.get(
      "X-Shopify-Hmac-SHA256"
    );

    const topic = req.get(
      "X-Shopify-Topic"
    );

    const shopDomain = String(
      req.get("X-Shopify-Shop-Domain") || ""
    )
      .trim()
      .toLowerCase();

    const webhookId = req.get(
      "X-Shopify-Webhook-Id"
    );

    // Check webhook topic.
    if (topic !== "orders/fulfilled") {
      return res
        .status(400)
        .send("Unexpected webhook topic.");
    }

    // Identify which Shopify store sent the webhook.
    if (!shopDomain || !STORES.has(shopDomain)) {
      console.warn(
        `Rejected webhook from unrecognized Shopify store: ${
          shopDomain || "missing domain"
        }`
      );

      return res
        .status(401)
        .send("Unexpected Shopify shop.");
    }

    const storeConfig = STORES.get(shopDomain);

    // Verify using the correct store's secret.
    if (
      !verifyShopifyWebhook(
        req.body,
        providedHmac,
        storeConfig.webhookSecret
      )
    ) {
      console.warn(
        `Rejected webhook: invalid HMAC signature for ${storeConfig.name}.`
      );

      return res
        .status(401)
        .send("Invalid webhook signature.");
    }

    // Parse order JSON.
    let order;

    try {
      order = JSON.parse(
        req.body.toString("utf8")
      );
    } catch {
      return res
        .status(400)
        .send("Invalid JSON payload.");
    }

    console.log(
      `Received orders/fulfilled webhook from ${storeConfig.name}. Delivery ID: ${
        webhookId || "not provided"
      }`
    );

    const triggeredAt = req.get(
      "X-Shopify-Triggered-At"
    );

    // Serialize processing so simultaneous deliveries
    // do not race while checking Google Sheets.

    const task = webhookProcessing.then(() =>
      processFulfilledOrder(
        order,
        triggeredAt,
        storeConfig
      )
    );

    webhookProcessing = task.catch(() => {});

    try {
      await task;

      return res
        .status(200)
        .send("Webhook processed.");
    } catch (error) {
      console.error(
        "Webhook processing failed:",
        error.message || error
      );

      return res
        .status(500)
        .send("Webhook processing failed.");
    }
  }
);

// ============================================================
// HEALTH CHECK
// ============================================================

app.get("/", (req, res) => {
  res
    .status(200)
    .send(
      "Shopify fulfillment webhook receiver is running."
    );
});

// ============================================================
// START SERVER AND REGISTER BOTH WEBHOOKS
// ============================================================

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `Shopify webhook app running on port ${PORT}`
  );

  console.log(
    "Configured webhook stores: WONDER and NAYA."
  );

  // Register both stores independently.
  // A failure registering one will not prevent
  // the other store from registering.

  ensureWebhookRegistered().catch((error) => {
    console.error(
      "WONDER webhook registration failed:",
      error.message || error
    );
  });

  ensureNayaWebhookRegistered().catch((error) => {
    console.error(
      "NAYA webhook registration failed:",
      error.message || error
    );
  });
});