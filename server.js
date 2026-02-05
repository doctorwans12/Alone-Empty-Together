// server.js
if (process.env.NODE_ENV !== "production") {
  require("dotenv").config();
}

const express = require("express");
const path = require("path");
const nodemailer = require("nodemailer");
const cron = require("node-cron");
const Stripe = require("stripe");

// ---- VALIDARE ENV (ca să nu pornești serverul “în gol”) ----
const REQUIRED_ENVS = [
  "STRIPE_SECRET_KEY",
  "PRICE_ID_SUB",
  "PRICE_ID_ONCE",
  "GMAIL_USER",
  "GMAIL_PASS",
];

for (const k of REQUIRED_ENVS) {
  if (!process.env[k]) {
    console.error(`❌ Missing env var: ${k}`);
    process.exit(1);
  }
}

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// ---- CONTENT (100 zile / 100 săpt) ----
const weeklyContent = require("./content.js");
if (!Array.isArray(weeklyContent) || weeklyContent.length === 0) {
  console.error("❌ content.js must export a non-empty array of strings.");
  process.exit(1);
}

// ---- DB (lowdb v1) ----
const low = require("lowdb");
const FileSync = require("lowdb/adapters/FileSync");
const adapter = new FileSync("db.json");
const db = low(adapter);

// { subscribers: [{ email, currentWeek, plan, isSub, createdAt, lastSentAt }] }
db.defaults({ subscribers: [] }).write();

// ---- APP ----
const app = express();
app.set("trust proxy", 1); // ✅ important pentru Railway (https + proxy)
app.use(express.json());

// Static files (index.html, logo.png, favicon.png etc.)
app.use(express.static(__dirname));

// ---- NODEMAILER (GMAIL SMTP) ----
const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 465,
  secure: true,
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_PASS,
  },
  tls: { rejectUnauthorized: false },

  // ✅ ca să nu blocheze mult request-ul dacă Gmail e lent
  connectionTimeout: 8000,
  greetingTimeout: 8000,
  socketTimeout: 8000,
});

// ---- HELPERS ----
const allowedPlans = new Set(["striker", "grappler", "hybrid", "traditional"]);

function getBaseUrl(req) {
  // ✅ Preferăm BASE_URL dacă e setat în Railway, altfel construim corect din headers.
  if (process.env.BASE_URL) return process.env.BASE_URL.replace(/\/$/, "");
  const proto = (req.headers["x-forwarded-proto"] || "https").split(",")[0];
  return `${proto}://${req.get("host")}`;
}

function safeEmailFromSession(session) {
  // Stripe poate avea email în customer_details sau în customer_email (în funcție de config)
  return session?.customer_details?.email || session?.customer_email || null;
}

function pickNextMessage(user) {
  if (user.currentWeek >= weeklyContent.length) return null;
  return weeklyContent[user.currentWeek];
}

async function sendWeeklyEmail(user) {
  const msg = pickNextMessage(user);
  if (!msg) return false;

  const weekNumber = user.currentWeek + 1;

  const mailOptions = {
    from: `"Personal Trainer" <${process.env.GMAIL_USER}>`,
    to: user.email,
    subject: `Your Plan: Week ${weekNumber}`,
    text: msg,
  };

  await transporter.sendMail(mailOptions);

  // Update progress
  db.get("subscribers")
    .find({ email: user.email })
    .assign({
      currentWeek: user.currentWeek + 1,
      lastSentAt: new Date().toISOString(),
    })
    .write();

  console.log(`✅ Sent Week ${weekNumber} to: ${user.email}`);
  return true;
}

async function sendWelcomeEmail(email) {
  const welcomeText = weeklyContent[0] || "Welcome!";
  const welcomeMail = {
    from: `"Personal Trainer" <${process.env.GMAIL_USER}>`,
    to: email,
    subject: "Important: Your Training Results",
    text: `Hi! Thank you for subscribing.\n\nHere is your professional roadmap (Week 1):\n\n${welcomeText}`,
  };

  await transporter.sendMail(welcomeMail);

  db.get("subscribers")
    .find({ email })
    .assign({
      currentWeek: 1,
      lastSentAt: new Date().toISOString(),
    })
    .write();

  console.log("✅ Welcome email sent!");
  return true;
}

function shouldSendWelcome(user) {
  if (!user) return true;
  if (user.currentWeek > 0) return false;
  return !user.lastSentAt;
}

// ---- CRON: every day at 09:00 server time ----
cron.schedule("0 9 * * *", async () => {
  try {
    console.log("🔔 Weekly email cron started...");
    const subscribers = db.get("subscribers").value();

    for (const user of subscribers) {
      // trimitem doar abonatilor (isSub = true)
      if (!user.isSub) continue;

      // dacă a terminat contentul, nu mai trimitem
      if (user.currentWeek >= weeklyContent.length) continue;

      try {
        await sendWeeklyEmail(user);
      } catch (err) {
        console.log(`❌ Email failed for ${user.email}: ${err.message}`);
      }
    }
  } catch (err) {
    console.log("❌ Cron crashed:", err.message);
  }
});

// ---- ROUTES ----
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// Optional: status route (debug)
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    contentCount: weeklyContent.length,
    subscribers: db.get("subscribers").size().value(),
  });
});

// 1) PAYMENT SESSION
// Frontend calls: /pay-session?subscribe=true&choice=striker
async function createCheckoutSession({ isSub, choice, baseUrl }) {
  const priceId = isSub ? process.env.PRICE_ID_SUB : process.env.PRICE_ID_ONCE;

  return stripe.checkout.sessions.create({
    payment_method_types: ["card"],
    line_items: [{ price: priceId, quantity: 1 }],
    mode: isSub ? "subscription" : "payment",

    metadata: {
      plan: choice,
      isSub: String(isSub),
    },

    success_url: `${baseUrl}/success?session_id={CHECKOUT_SESSION_ID}&plan=${encodeURIComponent(
      choice
    )}&isSub=${isSub}`,
    cancel_url: `${baseUrl}/`,
  });
}

app.get("/pay-session", async (req, res) => {
  const isSub = req.query.subscribe === "true";
  const choice = (req.query.choice || "").trim();

  // validate choice (so you don’t store junk)
  if (!allowedPlans.has(choice)) {
    return res.status(400).send("Invalid plan/choice.");
  }

  try {
    const baseUrl = getBaseUrl(req);
    const session = await createCheckoutSession({ isSub, choice, baseUrl });

    return res.redirect(303, session.url);
  } catch (err) {
    console.error("Stripe FULL ERROR:", err);
    return res.status(500).send(err.message);
  }
});

// Frontend calls: POST /pay/session with JSON body { subscribe, choice }
app.post("/pay/session", async (req, res) => {
  const isSub = req.body?.subscribe === true || req.body?.subscribe === "true";
  const choice = (req.body?.choice || "").trim();

  if (!allowedPlans.has(choice)) {
    return res.status(400).json({ error: "Invalid plan/choice." });
  }

  try {
    const baseUrl = getBaseUrl(req);
    const session = await createCheckoutSession({ isSub, choice, baseUrl });
    return res.json({ url: session.url });
  } catch (err) {
    console.error("Stripe FULL ERROR:", err);
    return res.status(500).json({ error: err.message });
  }
});

// 2) SUCCESS (FAST)
// - Redirect imediat către user
// - DB + welcome email rulează în fundal
app.get("/success", async (req, res) => {
  const { session_id, plan, isSub } = req.query;
  if (!session_id) return res.redirect("/");

  let session;
  try {
    session = await stripe.checkout.sessions.retrieve(session_id);
  } catch (err) {
    console.error("Success Route Error (stripe retrieve):", err.message);
    return res.redirect("/");
  }

  const customerEmail = safeEmailFromSession(session);
  if (!customerEmail) {
    console.log("❌ No email found in Stripe session.");
    return res.redirect("/");
  }

  const sessionPlan = session?.metadata?.plan;
  const sessionIsSub = session?.metadata?.isSub;

  const resolvedPlan = sessionPlan || plan || "";
  const resolvedIsSub = sessionIsSub || isSub || "";

  const redirectPlan = allowedPlans.has(resolvedPlan) ? resolvedPlan : "";
  const storedPlan = allowedPlans.has(resolvedPlan) ? resolvedPlan : "unknown";

  // ✅ 1) răspuns rapid (userul nu mai așteaptă email / db)
  res.redirect(
    `/?session_id=${encodeURIComponent(session_id)}&plan=${encodeURIComponent(
      redirectPlan
    )}&isSub=${encodeURIComponent(resolvedIsSub)}`
  );

  // ✅ 2) restul în fundal
  setImmediate(async () => {
    try {
      if (resolvedIsSub === "true") {
        const userExists = db.get("subscribers").find({ email: customerEmail }).value();
        const shouldWelcome = shouldSendWelcome(userExists);

        if (!userExists) {
          db.get("subscribers")
            .push({
              email: customerEmail,
              currentWeek: 0,
              plan: storedPlan,
              isSub: true,
              createdAt: new Date().toISOString(),
              lastSentAt: null,
            })
            .write();

          console.log(`your plan: ${customerEmail}`);
        } else {
          db.get("subscribers")
            .find({ email: customerEmail })
            .assign({ isSub: true, plan: storedPlan || userExists.plan })
            .write();
        }

        if (shouldWelcome) {
          await sendWelcomeEmail(customerEmail);
        }
      }
    } catch (err) {
      console.error("Post-success work failed:", err.message);
    }
  });
});

// ---- START ----
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
