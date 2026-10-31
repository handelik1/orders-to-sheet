
import express from "express";
import crypto from "node:crypto";
import { google } from "googleapis";

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================================
// CONFIGURATION
// ============================================================

// WONDER
const SHOPIFY_STORE = process.env.SHOPIFY_STORE;
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET;

// NAYA
const NAYA_SHOPIFY_STORE = process.env.NAYA_SHOPIFY_STORE;
const NAYA_SHOPIFY_CLIENT_ID = process.env.NAYA_SHOPIFY_CLIENT_ID;
const NAYA_SHOPIFY_CLIENT_SECRET = process.env.NAYA_SHOPIFY_CLIENT_SECRET;
const NAYA_SHOPIFY_ACCESS_TOKEN = process.env.NAYA_SHOPIFY_ACCESS_TOKEN;

const SHOPIFY_API_VERSION = "2026-10";

const WEBHOOK_URL =
  "https://orders-to-sheet.onrender.com/webhooks/orders-fulfilled";

const NAYA_REDIRECT_URI =
  "https://orders-to-sheet.onrender.com/auth/naya/callback";

const REQUEST_TIMEOUT_MS = 20000;

// GOOGLE SHEETS
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID;
const GOOGLE_SHEET_TAB = process.env.GOOGLE_SHEET_TAB || "Sheet1";

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
    throw new Error(`Missing required environment variable: ${key}`);
  }
}

if (
  SHOPIFY_STORE.toLowerCase() ===
  NAYA_SHOPIFY_STORE.toLowerCase()
) {
  throw new Error("WONDER and NAYA must be different stores.");
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
// OAUTH STATE
// ============================================================

const oauthStates = new Map();

// ============================================================
// VERIFY SHOPIFY OAUTH CALLBACK HMAC
// ============================================================

function verifyOAuthHmac(queryString) {
  const params = new URLSearchParams(queryString);
  const providedHmac = params.get("hmac");

  if (!providedHmac) return false;

  params.delete("hmac");
  params.delete("signature");

  const message = [...params.entries()]
    .sort(([keyA], [keyB]) => keyA.localeCompare(keyB))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");

  const calculatedHmac = crypto
    .createHmac("sha256", NAYA_SHOPIFY_CLIENT_SECRET)
    .update(message)
    .digest("hex");

  const expected = Buffer.from(calculatedHmac, "hex");
  const received = Buffer.from(providedHmac, "hex");

  return (
    expected.length === received.length &&
    crypto.timingSafeEqual(expected, received)
  );
}

// ============================================================
// VERIFY SHOPIFY WEBHOOK HMAC
// ============================================================

function verifyShopifyWebhook(rawBody, providedHmac, secret) {
  if (!providedHmac || !secret || !Buffer.isBuffer(rawBody)) {
    return false;
  }

  const calculatedHmac = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("base64");

  const expected = Buffer.from(calculatedHmac);
  const received = Buffer.from(providedHmac);

  return (
    expected.length === received.length &&
    crypto.timingSafeEqual(expected, received)
  );
}

// ============================================================
// SHOPIFY GRAPHQL
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
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  const result = await response.json();

  if (!response.ok || result.errors?.length) {
    throw new Error(
      `Shopify GraphQL error: ${JSON.stringify(result.errors || result)}`
    );
  }

  return result.data;
}

// ============================================================
// REGISTER FULFILLMENT WEBHOOK
// ============================================================

async function registerFulfillmentWebhook(store, accessToken, storeName) {
  console.log(`Checking ${storeName} Shopify webhook registration...`);

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

  const data = await shopifyGraphQL(store, accessToken, query);

  const existing = data.webhookSubscriptions.nodes.find(
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

  console.log(`Registering ${storeName} ORDERS_FULFILLED webhook...`);

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
      `Could not register ${storeName} webhook: ${JSON.stringify(errors)}`
    );
  }

  console.log(
    `${storeName} webhook registered successfully. ID: ${
      created.webhookSubscription?.id || "unknown"
    }`
  );
}

// ============================================================
// REGISTER STORE WEBHOOKS
// ============================================================

async function ensureWebhookRegistered() {
  await registerFulfillmentWebhook(
    SHOPIFY_STORE,
    SHOPIFY_ACCESS_TOKEN,
    "WONDER"
  );
}

async function ensureNayaWebhookRegistered() {
  if (!NAYA_SHOPIFY_ACCESS_TOKEN) {
    console.log(
      "NAYA access token is not configured. Complete OAuth authorization."
    );
    return;
  }

  await registerFulfillmentWebhook(
    NAYA_SHOPIFY_STORE,
    NAYA_SHOPIFY_ACCESS_TOKEN,
    "NAYA"
  );
}

// ============================================================
// NAYA OAUTH: START
// ============================================================

app.get("/auth/naya/start", (req, res) => {
  const state = crypto.randomBytes(32).toString("hex");

  oauthStates.set(state, {
    createdAt: Date.now(),
  });

  const authorizationUrl = new URL(
    `https://${NAYA_SHOPIFY_STORE}/admin/oauth/authorize`
  );

  authorizationUrl.searchParams.set("client_id", NAYA_SHOPIFY_CLIENT_ID);
  authorizationUrl.searchParams.set("scope", "read_orders");
  authorizationUrl.searchParams.set("redirect_uri", NAYA_REDIRECT_URI);
  authorizationUrl.searchParams.set("state", state);

  console.log("Starting NAYA OAuth authorization.");

  res.redirect(authorizationUrl.toString());
});

// ============================================================
// NAYA OAUTH: CALLBACK
// ============================================================

app.get("/auth/naya/callback", async (req, res) => {
  try {
    const queryString = req.originalUrl.split("?")[1] || "";

    if (!verifyOAuthHmac(queryString)) {
      return res.status(401).send("Invalid Shopify OAuth signature.");
    }

    const shop = String(req.query.shop || "").trim().toLowerCase();
    const code = String(req.query.code || "");
    const state = String(req.query.state || "");

    if (shop !== NAYA_SHOPIFY_STORE.toLowerCase()) {
      return res.status(400).send("Unexpected Shopify store.");
    }

    if (!state || !oauthStates.has(state)) {
      return res.status(403).send("Invalid or expired OAuth state.");
    }

    const stateData = oauthStates.get(state);
    oauthStates.delete(state);

    if (Date.now() - stateData.createdAt > 10 * 60 * 1000) {
      return res.status(403).send("OAuth authorization expired. Start again.");
    }

    if (!code) {
      return res.status(400).send("Shopify did not provide an authorization code.");
    }

    console.log(
      "NAYA authorization approved. Exchanging authorization code..."
    );

    const tokenResponse = await fetch(
      `https://${NAYA_SHOPIFY_STORE}/admin/oauth/access_token`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          client_id: NAYA_SHOPIFY_CLIENT_ID,
          client_secret: NAYA_SHOPIFY_CLIENT_SECRET,
          code,
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }
    );

    const tokenResult = await tokenResponse.json();

    if (!tokenResponse.ok || !tokenResult.access_token) {
      throw new Error(
        `NAYA token exchange failed. HTTP ${tokenResponse.status}: ${JSON.stringify(tokenResult)}`
      );
    }

    const grantedScopes = String(tokenResult.scope || "")
      .split(",")
      .map((scope) => scope.trim());

    if (!grantedScopes.includes("read_orders")) {
      throw new Error(
        `NAYA token does not include read_orders. Granted scopes: ${tokenResult.scope || "none"}`
      );
    }

    const accessToken = tokenResult.access_token;

    console.log("NAYA offline access token obtained successfully.");

    let registrationMessage;

    try {
      await registerFulfillmentWebhook(
        NAYA_SHOPIFY_STORE,
        accessToken,
        "NAYA"
      );

      registrationMessage =
        "NAYA fulfillment webhook registered successfully.";
    } catch (error) {
      console.error("NAYA webhook registration failed:", error.message || error);

      registrationMessage =
        `Token obtained, but webhook registration failed: ${error.message || error}`;
    }

    const safeToken = accessToken
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

    const safeMessage = registrationMessage
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

    res.status(200).type("html").send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>NAYA Shopify Authorization</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          body {
            font-family: Arial, sans-serif;
            max-width: 750px;
            margin: 50px auto;
            padding: 20px;
            line-height: 1.5;
          }
          textarea {
            width: 100%;
            min-height: 100px;
            box-sizing: border-box;
            padding: 12px;
            font-family: monospace;
            overflow-wrap: anywhere;
          }
          button {
            padding: 12px 20px;
            cursor: pointer;
          }
        </style>
      </head>
      <body>
        <h2>NAYA Shopify Authorization Complete</h2>
        <p>${safeMessage}</p>
        <h3>Your NAYA offline access token</h3>
        <p>Copy this token and save it in Render as NAYA_SHOPIFY_ACCESS_TOKEN.</p>
        <textarea id="token" readonly>${safeToken}</textarea>
        <p><button onclick="copyToken()">Copy access token</button></p>
        <p>After saving the token in Render, redeploy the service.</p>
        <script>
          function copyToken() {
            const field = document.getElementById("token");
            field.select();
            field.setSelectionRange(0, field.value.length);
            navigator.clipboard.writeText(field.value);
          }
        </script>
      </body>
      </html>
    `);
  } catch (error) {
    console.error("NAYA OAuth callback failed:", error.message || error);

    res.status(500).send(
      `NAYA authorization failed: ${error.message || error}`
    );
  }
});

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
// PROCESS FULFILLED ORDER
// ============================================================

async function processFulfilledOrder(order, triggeredAt, storeConfig) {
  const orderNumber = String(order.name || "").trim();

  if (!orderNumber) {
    throw new Error("Webhook order has no order number.");
  }

  if (order.fulfillment_status !== "fulfilled") {
    console.log(
      `Ignoring ${orderNumber}: fulfillment status is ${order.fulfillment_status ?? "null"}.`
    );
    return;
  }

  console.log(
    `Checking spreadsheet for ${orderNumber} from ${storeConfig.name}...`
  );

  const existingResponse = await sheets.spreadsheets.values.get(
    {
      spreadsheetId: GOOGLE_SHEET_ID,
      range: ORDER_NUMBER_RANGE,
    },
    {
      timeout: REQUEST_TIMEOUT_MS,
    }
  );

  const alreadyExists = (existingResponse.data.values || []).some(
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
    throw new Error(`Invalid total for ${orderNumber}.`);
  }

  const totalCents = Math.round(total * 100);
  const tenPercentCents = Math.round(totalCents * 0.1);

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
// ============================================================

let webhookProcessing = Promise.resolve();

app.post(
  "/webhooks/orders-fulfilled",
  express.raw({
    type: "application/json",
    limit: "2mb",
  }),
  async (req, res) => {
    const providedHmac = req.get("X-Shopify-Hmac-SHA256");
    const topic = req.get("X-Shopify-Topic");

    const shopDomain = String(
      req.get("X-Shopify-Shop-Domain") || ""
    )
      .trim()
      .toLowerCase();

    const webhookId = req.get("X-Shopify-Webhook-Id");

    if (topic !== "orders/fulfilled") {
      return res.status(400).send("Unexpected webhook topic.");
    }

    if (!shopDomain || !STORES.has(shopDomain)) {
      console.warn(
        `Rejected webhook from unrecognized Shopify store: ${shopDomain || "missing domain"}`
      );
      return res.status(401).send("Unexpected Shopify shop.");
    }

    const storeConfig = STORES.get(shopDomain);

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
      return res.status(401).send("Invalid webhook signature.");
    }

    let order;

    try {
      order = JSON.parse(req.body.toString("utf8"));
    } catch {
      return res.status(400).send("Invalid JSON payload.");
    }

    console.log(
      `Received orders/fulfilled webhook from ${storeConfig.name}. Delivery ID: ${webhookId || "not provided"}`
    );

    const triggeredAt = req.get("X-Shopify-Triggered-At");

    const task = webhookProcessing.then(() =>
      processFulfilledOrder(order, triggeredAt, storeConfig)
    );

    webhookProcessing = task.catch(() => {});

    try {
      await task;
      return res.status(200).send("Webhook processed.");
    } catch (error) {
      console.error("Webhook processing failed:", error.message || error);
      return res.status(500).send("Webhook processing failed.");
    }
  }
);

// ============================================================
// HOMEPAGE / HEALTH CHECK
// ============================================================

app.get("/", (req, res) => {
  res.status(200).type("text").send(
    [
      "Shopify fulfillment webhook receiver is running.",
      "",
      "WONDER: Configured",
      `NAYA: ${NAYA_SHOPIFY_ACCESS_TOKEN ? "Access token configured" : "OAuth token not configured"}`,
      "",
      "Webhook endpoint: /webhooks/orders-fulfilled",
    ].join("\n")
  );
});

// ============================================================
// START SERVER AND REGISTER WEBHOOKS
// ============================================================

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Shopify webhook app running on port ${PORT}`);
  console.log("Configured webhook stores: WONDER and NAYA.");

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
