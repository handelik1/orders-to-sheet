
import express from "express";
import crypto from "node:crypto";
import dotenv from "dotenv";
import { google } from "googleapis";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

const REQUIRED_ENV = [
  "SHOPIFY_WEBHOOK_SECRET",
  "GOOGLE_SHEET_ID",
  "GOOGLE_SERVICE_ACCOUNT_EMAIL",
  "GOOGLE_PRIVATE_KEY",
];

for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
}

const privateKey = process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n");

const auth = new google.auth.GoogleAuth({
  credentials: {
    client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    private_key: privateKey,
  },
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const sheets = google.sheets({ version: "v4", auth });

const SPREADSHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_TAB = process.env.GOOGLE_SHEET_TAB || "Sheet1";

// Shopify requires the original raw request body for signature verification.
app.post(
  "/webhooks/orders-fulfilled",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const hmacHeader = req.get("X-Shopify-Hmac-Sha256");

    if (!hmacHeader || !Buffer.isBuffer(req.body)) {
      return res.status(400).send("Invalid webhook request");
    }

    const digest = crypto
      .createHmac("sha256", process.env.SHOPIFY_WEBHOOK_SECRET)
      .update(req.body)
      .digest();

    let suppliedDigest;

    try {
      suppliedDigest = Buffer.from(hmacHeader, "base64");
    } catch {
      return res.status(401).send("Invalid signature");
    }

    if (
      suppliedDigest.length !== digest.length ||
      !crypto.timingSafeEqual(suppliedDigest, digest)
    ) {
      return res.status(401).send("Invalid Shopify signature");
    }

    let order;

    try {
      order = JSON.parse(req.body.toString("utf8"));
    } catch {
      return res.status(400).send("Invalid JSON");
    }

    try {
      // Only record orders that are fully fulfilled.
      // Ignore partial fulfillments.
      if (order.fulfillment_status !== "fulfilled") {
        console.log(`Order ${order.name} is not fully fulfilled; skipped.`);
        return res.status(200).send("Not fully fulfilled; skipped");
      }

      if (order.id == null || !order.name || order.total_price == null) {
        throw new Error("Webhook is missing required order information");
      }

      // Use the most recent fulfillment timestamp when available.
      const fulfillments = Array.isArray(order.fulfillments)
        ? order.fulfillments
        : [];

      const fulfillmentDates = fulfillments
        .map((fulfillment) => fulfillment.created_at)
        .filter(Boolean)
        .map((date) => new Date(date))
        .filter((date) => !Number.isNaN(date.getTime()));

      const latestFulfillment = fulfillmentDates.length
        ? new Date(Math.max(...fulfillmentDates.map((date) => date.getTime())))
        : null;

      const fulfillmentDate = (
        latestFulfillment || new Date()
      ).toLocaleDateString("en-US", {
        timeZone: "America/New_York",
        month: "2-digit",
        day: "2-digit",
        year: "numeric",
      });

      // Check existing order numbers in column B.
      const existing = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: `${SHEET_TAB}!B:B`,
      });

      const orderNumbers = (existing.data.values || [])
        .flat()
        .map((value) => String(value).trim());

      if (orderNumbers.includes(String(order.name).trim())) {
        console.log(`Order ${order.name} already exists; skipped.`);
        return res.status(200).send("Order already recorded");
      }

      // Convert to cents to avoid floating-point rounding errors.
      const priceCents = Math.round(Number(order.total_price) * 100);

      if (!Number.isFinite(priceCents) || priceCents < 0) {
        throw new Error("Invalid order total");
      }

      const commissionCents = Math.round(priceCents * 0.10);

      const price = priceCents / 100;
      const tenPercent = commissionCents / 100;

      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: `${SHEET_TAB}!A:E`,
        valueInputOption: "USER_ENTERED",
        insertDataOption: "INSERT_ROWS",
        requestBody: {
          values: [[
            fulfillmentDate,
            order.name,
            "wonder portal",
            price,
            tenPercent,
          ]],
        },
      });

      console.log(
        `Recorded order ${order.name}: $${price.toFixed(2)}, ` +
        `10% = $${tenPercent.toFixed(2)}`
      );

      return res.status(200).send("Order recorded");
    } catch (error) {
      console.error("Failed to record Shopify order:", error);

      // A non-200 response lets Shopify retry the webhook.
      return res.status(500).send("Failed to record order");
    }
  }
);

app.get("/", (req, res) => {
  res.status(200).send("Wonder Portal order logger is running.");
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
