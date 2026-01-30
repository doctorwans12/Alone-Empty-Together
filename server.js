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

  // ✅ 1) RĂSPUNS IMEDIAT către user (nu mai așteaptă email/db)
  res.redirect(
    `/?session_id=${encodeURIComponent(session_id)}&plan=${encodeURIComponent(
      redirectPlan
    )}&isSub=${encodeURIComponent(resolvedIsSub)}`
  );

  // ✅ 2) RES
