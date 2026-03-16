const admin = require("firebase-admin");
const Stripe = require("stripe");
const cors = require("cors")({ origin: true });
const { Resend } = require("resend");

const { onRequest } = require("firebase-functions/v2/https");
const { onValueCreated } = require("firebase-functions/v2/database");
const { defineSecret, defineString } = require("firebase-functions/params");

admin.initializeApp();

// ---- Secrets ----
const STRIPE_SECRET_KEY = defineSecret("STRIPE_SECRET_KEY");
const STRIPE_WEBHOOK_SECRET = defineSecret("STRIPE_WEBHOOK_SECRET");
const RESEND_API_KEY = defineSecret("RESEND_API_KEY");

// ---- Optional string params ----
const FRONTEND_SUCCESS_URL = defineString("FRONTEND_SUCCESS_URL");
const FRONTEND_CANCEL_URL = defineString("FRONTEND_CANCEL_URL");

function getStripe() {
  const key = STRIPE_SECRET_KEY.value();
  if (!key) throw new Error("Stripe secret missing (STRIPE_SECRET_KEY not injected).");
  if (!key.startsWith("sk_")) throw new Error("Stripe secret looks wrong (must start with sk_).");
  return new Stripe(key, { apiVersion: "2023-10-16" });
}

function getResend() {
  const key = RESEND_API_KEY.value();
  if (!key) throw new Error("Resend API key missing (RESEND_API_KEY not injected).");
  return new Resend(key);
}

async function requireAuth(req) {
  const authHeader = req.headers.authorization || "";
  const match = authHeader.match(/^Bearer (.+)$/);
  if (!match) throw new Error("Missing Authorization Bearer token");
  const decoded = await admin.auth().verifyIdToken(match[1]);
  if (!decoded?.uid) throw new Error("Invalid token");
  return decoded;
}

function normalizeUrl(u) {
  return String(u || "").trim().replace(/\/$/, "");
}

/**** 💳 STRIPE PAYMENT INTENT ****/
exports.createPaymentIntent = onRequest(
  { secrets: [STRIPE_SECRET_KEY] },
  (req, res) => {
    cors(req, res, async () => {
      try {
        if (req.method !== "POST") {
          return res.status(405).json({ error: "Use POST" });
        }

        const stripe = getStripe();
        const { amount } = req.body || {};

        if (!amount || amount < 100) {
          return res.status(400).json({ error: "Invalid amount" });
        }

        const intent = await stripe.paymentIntents.create({
          amount,
          currency: "gbp",
          automatic_payment_methods: { enabled: true },
        });

        return res.json({ clientSecret: intent.client_secret });
      } catch (err) {
        console.error("Stripe error:", err);
        return res.status(500).json({ error: err.message });
      }
    });
  }
);

/**** 📧 SEND CLIENT BOOKING CONFIRMATION WITH RESEND ****/
exports.sendBookingConfirmationEmail = onValueCreated(
  {
    ref: "/bookings/{bookingId}",
    secrets: [RESEND_API_KEY]
  },
  async (event) => {
    const booking = event.data.val();
    const bookingId = event.params.bookingId;

    if (!booking) {
      console.log("No booking data found:", bookingId);
      return;
    }

    if (booking.status !== "confirmed") {
      console.log("Booking is not confirmed, skipping:", bookingId);
      return;
    }

    const clientEmail = String(booking.clientEmail || "").trim();
    if (!clientEmail) {
      console.log("No client email, skipping:", bookingId);
      return;
    }

    if (booking.notification?.clientConfirmationSent === true) {
      console.log("Confirmation already sent, skipping:", bookingId);
      return;
    }

    const resend = getResend();
    const bookingRef = admin.database().ref(`/bookings/${bookingId}`);

    try {
      const serviceName = booking.serviceName || booking.service || "Hair appointment";
      const clientName = booking.clientName || "Client";
      const date = booking.date || "";
      const time = booking.time || "";
      const deposit = Number(booking.deposit || 0);
      const remaining = Number(booking.remaining || 0);

      const result = await resend.emails.send({
        from: "Angels Hair Mall <bookings@yourdomain.com>",
        to: clientEmail,
        subject: "Your booking is confirmed",
        html: `
          <div style="font-family: Inter, Arial, sans-serif; color: #111; line-height: 1.6;">
            <h2>Your booking is confirmed 🎉</h2>
            <p>Hello ${escapeHtml(clientName)},</p>
            <p>Thank you for your booking with Angels Hair Mall.</p>

            <p><strong>Service:</strong> ${escapeHtml(serviceName)}</p>
            <p><strong>Date:</strong> ${escapeHtml(date)}</p>
            <p><strong>Time:</strong> ${escapeHtml(time)}</p>
            <p><strong>Deposit paid:</strong> £${deposit.toFixed(2)}</p>
            <p><strong>Remaining balance:</strong> £${remaining.toFixed(2)}</p>

            <p>We look forward to seeing you.</p>
          </div>
        `
      });

      await bookingRef.child("notification").update({
        clientConfirmationSent: true,
        clientConfirmationSentAt: Date.now(),
        clientConfirmationError: null,
        resendId: result?.data?.id || null
      });

      console.log("✅ Resend confirmation sent to:", clientEmail, "booking:", bookingId);
    } catch (error) {
      console.error("❌ Resend failed for booking:", bookingId, error);

      await bookingRef.child("notification").update({
        clientConfirmationSent: false,
        clientConfirmationSentAt: null,
        clientConfirmationError: String(error?.message || error)
      });
    }
  }
);

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}