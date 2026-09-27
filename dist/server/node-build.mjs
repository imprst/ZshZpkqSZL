import path from "path";
import * as express from "express";
import express__default from "express";
import cors from "cors";
import { randomUUID, createHash } from "node:crypto";
const handleDemo = (req, res) => {
  const response = {
    message: "Hello from Express server"
  };
  res.status(200).json(response);
};
const flutterwaveBaseUrl$2 = "https://api.flutterwave.com/v3";
const flutterwaveReturnPath$1 = "/checkout/flutterwave-return";
class FlutterwaveRequestError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}
const getFlutterwaveReturnUrl = () => {
  const returnUrl = process.env.FLUTTERWAVE_RETURN_URL;
  if (!returnUrl) throw new Error("Flutterwave return URL is not configured");
  const parsedUrl = new URL(returnUrl);
  if (parsedUrl.protocol !== "https:" || parsedUrl.pathname !== flutterwaveReturnPath$1) {
    throw new Error("Flutterwave return URL must use HTTPS and target the payment return route");
  }
  return parsedUrl.toString();
};
const getConfiguration$1 = () => {
  const secretKey = process.env.FLUTTERWAVE_SECRET_KEY;
  const secretHash = process.env.FLUTTERWAVE_SECRET_HASH;
  const supabaseUrl = process.env.VITE_SUPABASE_URL;
  const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY;
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const defaultCurrency = process.env.FLUTTERWAVE_CURRENCY || "USD";
  if (!secretKey || !secretHash || !supabaseUrl || !supabaseAnonKey || !supabaseServiceRoleKey) {
    throw new Error("Flutterwave payment configuration is incomplete");
  }
  return {
    secretKey,
    secretHash,
    supabaseUrl,
    supabaseAnonKey,
    supabaseServiceRoleKey,
    defaultCurrency
  };
};
const getAuthenticatedOrder = async (orderId, authorization) => {
  if (!authorization?.startsWith("Bearer ")) {
    throw new Error("Missing authenticated session");
  }
  const { supabaseUrl, supabaseAnonKey } = getConfiguration$1();
  const response = await fetch(
    `${supabaseUrl}/rest/v1/menu_orders?id=eq.${encodeURIComponent(orderId)}&select=*`,
    {
      headers: {
        apikey: supabaseAnonKey,
        authorization
      }
    }
  );
  if (!response.ok) throw new Error("Unable to retrieve this order");
  const [order] = await response.json();
  if (!order) throw new Error("Order not found");
  return order;
};
const getOrderByPaymentReference = async (paymentReference) => {
  const { supabaseUrl, supabaseAnonKey, supabaseServiceRoleKey } = getConfiguration$1();
  const response = await fetch(
    `${supabaseUrl}/rest/v1/menu_orders?payment_reference=eq.${encodeURIComponent(paymentReference)}&select=*`,
    {
      headers: {
        apikey: supabaseAnonKey,
        Authorization: `Bearer ${supabaseServiceRoleKey}`
      }
    }
  );
  if (!response.ok) throw new Error("Unable to retrieve payment order");
  const [order] = await response.json();
  if (!order) throw new Error("Payment order not found");
  return order;
};
const updatePaymentAttemptAsService = async (txRef, values) => {
  const { supabaseUrl, supabaseAnonKey, supabaseServiceRoleKey } = getConfiguration$1();
  const response = await fetch(
    `${supabaseUrl}/rest/v1/menu_payment_attempts?tx_ref=eq.${encodeURIComponent(txRef)}`,
    {
      method: "PATCH",
      headers: {
        apikey: supabaseAnonKey,
        Authorization: `Bearer ${supabaseServiceRoleKey}`,
        "content-type": "application/json",
        prefer: "return=minimal"
      },
      body: JSON.stringify({ ...values, updated_at: (/* @__PURE__ */ new Date()).toISOString() })
    }
  );
  if (!response.ok) throw new Error("Unable to update payment attempt");
};
const createPaymentAttemptAsService = async (values) => {
  const { supabaseUrl, supabaseAnonKey, supabaseServiceRoleKey } = getConfiguration$1();
  const response = await fetch(`${supabaseUrl}/rest/v1/menu_payment_attempts`, {
    method: "POST",
    headers: {
      apikey: supabaseAnonKey,
      Authorization: `Bearer ${supabaseServiceRoleKey}`,
      "content-type": "application/json",
      prefer: "return=minimal"
    },
    body: JSON.stringify(values)
  });
  if (!response.ok) throw new Error("Unable to create payment attempt");
};
const updateOrderAsService = async (orderId, values) => {
  const { supabaseUrl, supabaseAnonKey, supabaseServiceRoleKey } = getConfiguration$1();
  const response = await fetch(
    `${supabaseUrl}/rest/v1/menu_orders?id=eq.${encodeURIComponent(orderId)}`,
    {
      method: "PATCH",
      headers: {
        apikey: supabaseAnonKey,
        Authorization: `Bearer ${supabaseServiceRoleKey}`,
        "content-type": "application/json",
        prefer: "return=minimal"
      },
      body: JSON.stringify(values)
    }
  );
  if (!response.ok) throw new Error("Unable to update payment order");
};
const getPaymentOptions = (paymentMethod, currency) => {
  if (paymentMethod !== "mobile-money") return "card";
  if (currency !== "UGX") {
    throw new Error("Mobile Money is available only when checkout prices are configured in UGX.");
  }
  return "mobilemoneyuganda";
};
const verifyTransaction$2 = async (transactionId) => {
  const { secretKey } = getConfiguration$1();
  const response = await fetch(
    `${flutterwaveBaseUrl$2}/transactions/${encodeURIComponent(transactionId)}/verify`,
    { headers: { Authorization: `Bearer ${secretKey}` } }
  );
  const payload = await response.json();
  if (!response.ok || payload.status !== "success" || !payload.data) {
    throw new Error("Payment could not be verified");
  }
  return payload.data;
};
const confirmPayment = async (transaction, transactionReference, order) => {
  const metadataOrderId = transaction.meta?.order_id;
  if (metadataOrderId !== order.id) {
    throw new Error("Payment metadata does not match the order");
  }
  const { defaultCurrency } = getConfiguration$1();
  const currency = String(order.currency || defaultCurrency).toUpperCase();
  if (transaction.status !== "successful" || transaction.tx_ref !== transactionReference || Number(transaction.amount) !== Number(order.total_amount) || transaction.currency !== currency) {
    throw new Error("Payment verification data does not match the order");
  }
  if (order.payment_status === "paid") return { order, paymentStatus: "paid" };
  await updateOrderAsService(order.id, {
    status: "confirmed",
    payment_status: "paid",
    payment_reference: transactionReference,
    flutterwave_transaction_id: String(transaction.id)
  });
  await updatePaymentAttemptAsService(transactionReference, {
    transaction_id: String(transaction.id),
    status: "completed",
    completed_at: (/* @__PURE__ */ new Date()).toISOString()
  });
  return { order, paymentStatus: "paid" };
};
const prepareFlutterwaveHostedSession = async ({ orderId, paymentAmount, paymentCurrency }, authorization) => {
  let txRef;
  try {
    if (!orderId) throw new Error("Order ID is required");
    if (!Number.isFinite(paymentAmount) || paymentAmount <= 0 || !paymentCurrency) {
      throw new Error("Checkout amount is invalid");
    }
    const order = await getAuthenticatedOrder(orderId, authorization);
    if (order.payment_status === "paid") {
      throw new FlutterwaveRequestError("This order has already been paid", 409);
    }
    if (!order.email?.trim()) {
      throw new FlutterwaveRequestError("An email address is required for online payment.", 400);
    }
    const { secretKey } = getConfiguration$1();
    const amount = Number(paymentAmount);
    const currency = String(paymentCurrency).toUpperCase();
    await updateOrderAsService(order.id, {
      total_amount: amount,
      currency,
      payment_status: "pending"
    });
    txRef = `sheraton-${order.order_number}-${crypto.randomUUID()}`;
    await createPaymentAttemptAsService({
      order_id: order.id,
      tx_ref: txRef,
      amount,
      currency,
      status: "initiated"
    });
    const paymentOptions = getPaymentOptions(order.payment_method, currency);
    const returnUrl = getFlutterwaveReturnUrl();
    const response = await fetch(`${flutterwaveBaseUrl$2}/payments`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secretKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        tx_ref: txRef,
        amount,
        currency,
        payment_options: paymentOptions,
        redirect_url: returnUrl,
        customer: {
          email: order.email,
          name: `${order.first_name} ${order.last_name}`.trim(),
          phonenumber: order.phone
        },
        meta: { order_id: order.id },
        customizations: {
          title: "Sheraton Special",
          description: `Order ${order.order_number}`
        }
      })
    });
    const payload = await response.json();
    if (!response.ok || payload.status !== "success" || !payload.data?.link) {
      throw new Error("Unable to create secure payment page");
    }
    await updatePaymentAttemptAsService(txRef, {
      status: "redirected",
      payment_url: payload.data.link
    });
    await updateOrderAsService(order.id, {
      payment_reference: txRef,
      payment_status: "pending"
    });
    return {
      paymentUrl: payload.data.link,
      txRef,
      orderId: order.id
    };
  } catch (error) {
    if (txRef) {
      await updatePaymentAttemptAsService(txRef, {
        status: "failed",
        failure_reason: error instanceof Error ? error.message : "Unable to prepare payment"
      }).catch((attemptError) => console.error("Unable to record failed payment attempt", attemptError));
    }
    throw error;
  }
};
const createFlutterwaveHostedSession = async (req, res) => {
  try {
    const paymentSession = await prepareFlutterwaveHostedSession(
      req.body,
      req.headers.authorization
    );
    return res.json(paymentSession);
  } catch (error) {
    console.error("Flutterwave hosted session error", error);
    return res.status(error instanceof FlutterwaveRequestError ? error.status : 400).json({
      error: error instanceof Error ? error.message : "Unable to prepare payment"
    });
  }
};
const cancelFlutterwavePayment = async (req, res) => {
  try {
    const { txRef, status } = req.body;
    if (!txRef) return res.status(400).json({ error: "Payment reference is required" });
    if (status !== "cancelled" && status !== "failed") {
      return res.status(400).json({ error: "Payment outcome is invalid" });
    }
    const order = await getOrderByPaymentReference(txRef);
    await getAuthenticatedOrder(order.id, req.headers.authorization);
    await updatePaymentAttemptAsService(txRef, {
      status,
      ...status === "cancelled" ? { cancelled_at: (/* @__PURE__ */ new Date()).toISOString() } : { failure_reason: "Flutterwave returned an unsuccessful payment status" }
    });
    await updateOrderAsService(order.id, { payment_status: status });
    return res.json({ orderId: order.id, paymentStatus: status });
  } catch (error) {
    console.error("Flutterwave payment cancellation error", error);
    return res.status(400).json({
      error: error instanceof Error ? error.message : "Unable to record payment cancellation"
    });
  }
};
const verifyFlutterwavePayment = async (req, res) => {
  try {
    const { transactionId, txRef } = req.body;
    if (!transactionId || !txRef) {
      return res.status(400).json({ error: "Payment verification details are required" });
    }
    const order = await getOrderByPaymentReference(txRef);
    await getAuthenticatedOrder(order.id, req.headers.authorization);
    const transaction = await verifyTransaction$2(String(transactionId));
    const result = await confirmPayment(transaction, txRef, order);
    return res.json({
      orderId: result.order.id,
      orderNumber: result.order.order_number,
      paymentStatus: result.paymentStatus
    });
  } catch (error) {
    console.error("Flutterwave payment verification error", error);
    return res.status(400).json({
      error: error instanceof Error ? error.message : "Unable to verify payment"
    });
  }
};
const handleFlutterwaveWebhook = async (req, res) => {
  const signature = req.headers["verif-hash"];
  const { secretHash } = getConfiguration$1();
  if (!signature || signature !== secretHash) {
    return res.status(401).end();
  }
  const payload = req.body;
  if (payload.event !== "charge.completed" || !payload.data?.id || !payload.data.tx_ref) {
    return res.status(200).end();
  }
  try {
    const order = await getOrderByPaymentReference(payload.data.tx_ref);
    await confirmPayment(
      await verifyTransaction$2(String(payload.data.id)),
      payload.data.tx_ref,
      order
    );
    return res.status(200).end();
  } catch (error) {
    console.error("Flutterwave webhook processing error", error);
    return res.status(500).end();
  }
};
const flutterwaveBaseUrl$1 = "https://api.flutterwave.com/v3";
const flutterwaveReturnPath = "/checkout/flutterwave-return";
class SpecialEventPaymentError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}
const getConfiguration = () => {
  const secretKey = process.env.FLUTTERWAVE_SECRET_KEY;
  const secretHash = process.env.FLUTTERWAVE_SECRET_HASH;
  const supabaseUrl = process.env.VITE_SUPABASE_URL;
  const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY;
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secretKey || !supabaseUrl || !supabaseAnonKey || !supabaseServiceRoleKey) {
    throw new Error("Event payment configuration is incomplete");
  }
  return { secretKey, secretHash, supabaseUrl, supabaseAnonKey, supabaseServiceRoleKey };
};
const getReturnUrl$1 = () => {
  const value = process.env.FLUTTERWAVE_RETURN_URL;
  if (!value) throw new Error("Flutterwave return URL is not configured");
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" || parsed.pathname !== flutterwaveReturnPath) {
    throw new Error("Flutterwave return URL must use HTTPS and target the payment return route");
  }
  return parsed.toString();
};
const restHeaders = (token, anonKey, json = false) => ({
  apikey: anonKey,
  Authorization: `Bearer ${token}`,
  ...json ? { "content-type": "application/json" } : {}
});
const getBooking$1 = async (bookingId, authorization) => {
  if (!authorization?.startsWith("Bearer ")) throw new SpecialEventPaymentError("Missing authenticated session", 401);
  const { supabaseUrl, supabaseAnonKey } = getConfiguration();
  const response = await fetch(`${supabaseUrl}/rest/v1/special_event_bookings?id=eq.${encodeURIComponent(bookingId)}&select=*`, {
    headers: restHeaders(authorization.slice("Bearer ".length), supabaseAnonKey)
  });
  if (!response.ok) throw new Error("Unable to retrieve event booking");
  const [booking] = await response.json();
  if (!booking) throw new SpecialEventPaymentError("Event booking not found", 404);
  return booking;
};
const getBookingAsService = async (bookingId) => {
  const { supabaseUrl, supabaseAnonKey, supabaseServiceRoleKey } = getConfiguration();
  const response = await fetch(`${supabaseUrl}/rest/v1/special_event_bookings?id=eq.${encodeURIComponent(bookingId)}&select=*`, {
    headers: restHeaders(supabaseServiceRoleKey, supabaseAnonKey)
  });
  if (!response.ok) throw new Error("Unable to retrieve event booking");
  const [booking] = await response.json();
  if (!booking) throw new Error("Event booking not found");
  return booking;
};
const getPaymentAttemptAsService = async (txRef) => {
  const { supabaseUrl, supabaseAnonKey, supabaseServiceRoleKey } = getConfiguration();
  const response = await fetch(`${supabaseUrl}/rest/v1/special_event_payment_attempts?tx_ref=eq.${encodeURIComponent(txRef)}&select=id,booking_id,tx_ref,transaction_id,amount,currency,status`, {
    headers: restHeaders(supabaseServiceRoleKey, supabaseAnonKey)
  });
  if (!response.ok) throw new Error("Unable to retrieve event payment attempt");
  const [attempt] = await response.json();
  if (!attempt) throw new SpecialEventPaymentError("Event payment attempt not found", 404);
  return attempt;
};
const getActivePaymentAttempt = async (bookingId) => {
  const { supabaseUrl, supabaseAnonKey, supabaseServiceRoleKey } = getConfiguration();
  const response = await fetch(
    `${supabaseUrl}/rest/v1/special_event_payment_attempts?booking_id=eq.${encodeURIComponent(bookingId)}&status=in.(initiated,redirected,verified)&select=id,booking_id,tx_ref,transaction_id,amount,currency,status,payment_url,created_at&order=created_at.desc&limit=1`,
    { headers: restHeaders(supabaseServiceRoleKey, supabaseAnonKey) }
  );
  if (!response.ok) throw new Error("Unable to retrieve active event payment attempt");
  const [attempt] = await response.json();
  return attempt || null;
};
const createPaymentAttempt = async (values) => {
  const { supabaseUrl, supabaseAnonKey, supabaseServiceRoleKey } = getConfiguration();
  const response = await fetch(`${supabaseUrl}/rest/v1/special_event_payment_attempts`, {
    method: "POST",
    headers: { ...restHeaders(supabaseServiceRoleKey, supabaseAnonKey, true), Prefer: "return=minimal" },
    body: JSON.stringify(values)
  });
  if (!response.ok) throw new Error("Unable to create event payment attempt");
};
const updatePaymentAttempt = async (txRef, values) => {
  const { supabaseUrl, supabaseAnonKey, supabaseServiceRoleKey } = getConfiguration();
  const response = await fetch(`${supabaseUrl}/rest/v1/special_event_payment_attempts?tx_ref=eq.${encodeURIComponent(txRef)}`, {
    method: "PATCH",
    headers: { ...restHeaders(supabaseServiceRoleKey, supabaseAnonKey, true), Prefer: "return=minimal" },
    body: JSON.stringify({ ...values, updated_at: (/* @__PURE__ */ new Date()).toISOString() })
  });
  if (!response.ok) throw new Error("Unable to update event payment attempt");
};
const verifyTransaction$1 = async (transactionId) => {
  const { secretKey } = getConfiguration();
  const response = await fetch(`${flutterwaveBaseUrl$1}/transactions/${encodeURIComponent(transactionId)}/verify`, {
    headers: { Authorization: `Bearer ${secretKey}` }
  });
  const payload = await response.json();
  if (!response.ok || payload.status !== "success" || !payload.data) throw new Error("Event payment could not be verified");
  return payload.data;
};
const confirmBookingAsService = async (bookingId, transactionId) => {
  const { supabaseUrl, supabaseAnonKey, supabaseServiceRoleKey } = getConfiguration();
  const response = await fetch(`${supabaseUrl}/rest/v1/rpc/confirm_special_event_payment`, {
    method: "POST",
    headers: { ...restHeaders(supabaseServiceRoleKey, supabaseAnonKey, true), Prefer: "return=representation" },
    body: JSON.stringify({ target_booking_id: bookingId, target_transaction_id: transactionId })
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = payload && !Array.isArray(payload) ? [payload.message, payload.details, payload.hint].filter((value) => typeof value === "string" && Boolean(value.trim())).join(" — ") : "";
    throw new Error(error || "Unable to confirm event booking");
  }
  const [confirmation] = Array.isArray(payload) ? payload : [];
  if (!confirmation) throw new Error("Event booking confirmation was not returned");
  return confirmation;
};
const assertTransactionMatches = (transaction, attempt, booking) => {
  if (transaction.status !== "successful" || transaction.tx_ref !== attempt.tx_ref) throw new Error("Event payment status does not match the booking");
  if (Number(transaction.amount) !== Number(booking.total_amount) || Number(transaction.amount) !== Number(attempt.amount) || transaction.currency.toUpperCase() !== booking.currency.toUpperCase() || transaction.currency.toUpperCase() !== attempt.currency.toUpperCase()) throw new Error("Event payment amount does not match the booking");
  if (transaction.meta?.booking_id !== booking.id) throw new Error("Event payment metadata does not match the booking");
};
const prepareSpecialEventPayment = async (req, res) => {
  let bookingId;
  let txRef;
  try {
    bookingId = req.body.bookingId;
    if (!bookingId) throw new SpecialEventPaymentError("Booking ID is required");
    const booking = await getBooking$1(bookingId, req.headers.authorization);
    if (booking.payment_status === "paid") throw new SpecialEventPaymentError("This event booking has already been paid", 409);
    if (booking.status !== "pending" || booking.payment_status !== "pending") throw new SpecialEventPaymentError("This event booking is no longer pending", 409);
    if (booking.expires_at && new Date(booking.expires_at).getTime() <= Date.now()) throw new SpecialEventPaymentError("This ticket hold has expired. Start a new booking.", 409);
    if (Number(booking.total_amount) <= 0) throw new SpecialEventPaymentError("This booking does not require online payment", 400);
    const { secretKey } = getConfiguration();
    const activeAttempt = await getActivePaymentAttempt(booking.id);
    if (activeAttempt?.status === "redirected" && activeAttempt.payment_url) {
      return res.json({ paymentUrl: activeAttempt.payment_url, txRef: activeAttempt.tx_ref, bookingId: booking.id });
    }
    if (activeAttempt?.status === "verified") {
      throw new SpecialEventPaymentError("Payment verification is still processing. Refresh My Events shortly.", 409);
    }
    if (activeAttempt?.status === "initiated") {
      const attemptAge = Date.now() - new Date(activeAttempt.created_at).getTime();
      if (attemptAge < 12e4) {
        throw new SpecialEventPaymentError("Secure checkout is being prepared. Try again in a moment.", 409);
      }
      await updatePaymentAttempt(activeAttempt.tx_ref, { status: "expired", failure_reason: "Checkout preparation timed out" });
    }
    txRef = `special-event-${booking.order_number}-${randomUUID()}`;
    try {
      await createPaymentAttempt({ booking_id: booking.id, tx_ref: txRef, amount: Number(booking.total_amount), currency: booking.currency, status: "initiated" });
    } catch (error) {
      const racedAttempt = await getActivePaymentAttempt(booking.id);
      if (racedAttempt?.status === "redirected" && racedAttempt.payment_url) {
        return res.json({ paymentUrl: racedAttempt.payment_url, txRef: racedAttempt.tx_ref, bookingId: booking.id });
      }
      throw error;
    }
    const response = await fetch(`${flutterwaveBaseUrl$1}/payments`, {
      method: "POST",
      headers: { Authorization: `Bearer ${secretKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        tx_ref: txRef,
        amount: Number(booking.total_amount),
        currency: booking.currency,
        payment_options: "card",
        redirect_url: getReturnUrl$1(),
        customer: { email: booking.guest_email, name: `${booking.guest_first_name} ${booking.guest_last_name}`.trim(), phonenumber: booking.guest_phone },
        meta: { booking_id: booking.id, order_number: booking.order_number },
        customizations: { title: "Special Events", description: `Event booking ${booking.order_number}` }
      })
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.status !== "success" || !payload.data?.link) {
      const providerMessage = typeof payload?.message === "string" ? payload.message : "Flutterwave did not return a checkout link";
      throw new SpecialEventPaymentError(`Flutterwave checkout failed: ${providerMessage}`, 502);
    }
    await updatePaymentAttempt(txRef, { status: "redirected", payment_url: payload.data.link });
    return res.json({ paymentUrl: payload.data.link, txRef, bookingId: booking.id });
  } catch (error) {
    console.error("Special event checkout initialization failed", { bookingId, txRef, error });
    if (txRef) await updatePaymentAttempt(txRef, { status: "failed", failure_reason: error instanceof Error ? error.message : "Unable to prepare event payment" }).catch(() => void 0);
    return res.status(error instanceof SpecialEventPaymentError ? error.status : 502).json({ error: error instanceof Error ? error.message : "Unable to prepare event payment" });
  }
};
const verifySpecialEventPayment = async (req, res) => {
  try {
    const { transactionId, txRef } = req.body;
    if (!transactionId || !txRef) return res.status(400).json({ error: "Event payment verification details are required" });
    const attempt = await getPaymentAttemptAsService(txRef);
    const booking = await getBooking$1(attempt.booking_id, req.headers.authorization);
    const transaction = await verifyTransaction$1(String(transactionId));
    assertTransactionMatches(transaction, attempt, booking);
    if (attempt.status !== "successful" && attempt.status !== "manual_review") {
      await updatePaymentAttempt(txRef, { transaction_id: String(transaction.id), status: "verified" });
    }
    const confirmation = await confirmBookingAsService(booking.id, String(transaction.id));
    return res.json({ bookingId: confirmation.booking_id, orderNumber: confirmation.order_number, confirmationNumber: confirmation.confirmation_number, ticketCode: confirmation.ticket_code, paymentStatus: confirmation.payment_status });
  } catch (error) {
    return res.status(error instanceof SpecialEventPaymentError ? error.status : 400).json({ error: error instanceof Error ? error.message : "Unable to verify event payment" });
  }
};
const cancelSpecialEventPayment = async (req, res) => {
  try {
    const { txRef, status } = req.body;
    if (!txRef || status !== "cancelled" && status !== "failed") return res.status(400).json({ error: "Event payment outcome is invalid" });
    const attempt = await getPaymentAttemptAsService(txRef);
    await getBooking$1(attempt.booking_id, req.headers.authorization);
    if (attempt.status === "successful" || attempt.status === "manual_review") {
      return res.json({ bookingId: attempt.booking_id, paymentStatus: attempt.status });
    }
    if (attempt.status === "initiated" || attempt.status === "redirected") {
      await updatePaymentAttempt(txRef, status === "cancelled" ? { status, cancelled_at: (/* @__PURE__ */ new Date()).toISOString() } : { status, failure_reason: "Flutterwave returned an unsuccessful payment status" });
    }
    return res.json({ bookingId: attempt.booking_id, paymentStatus: status });
  } catch (error) {
    return res.status(error instanceof SpecialEventPaymentError ? error.status : 400).json({ error: error instanceof Error ? error.message : "Unable to record event payment cancellation" });
  }
};
const handleSpecialEventWebhook = async (req, res) => {
  const { secretHash } = getConfiguration();
  if (!secretHash) {
    console.error("Special event webhook secret is not configured");
    return res.status(503).end();
  }
  if (req.headers["verif-hash"] !== secretHash) return res.status(401).end();
  const payload = req.body;
  if (payload.event !== "charge.completed" || !payload.data?.id || !payload.data.tx_ref) return res.status(200).end();
  try {
    const attempt = await getPaymentAttemptAsService(payload.data.tx_ref);
    const booking = await getBookingAsService(attempt.booking_id);
    const transaction = await verifyTransaction$1(String(payload.data.id));
    assertTransactionMatches(transaction, attempt, booking);
    if (attempt.status !== "successful" && attempt.status !== "manual_review") {
      await updatePaymentAttempt(payload.data.tx_ref, { transaction_id: String(transaction.id), status: "verified" });
    }
    await confirmBookingAsService(booking.id, String(transaction.id));
    return res.status(200).end();
  } catch (error) {
    console.error("Special event webhook processing error", error);
    return res.status(500).end();
  }
};
const flutterwaveBaseUrl = "https://api.flutterwave.com/v3";
const supportedCurrencies = /* @__PURE__ */ new Set(["USD", "UGX", "EUR", "GBP", "KES", "TZS", "RWF"]);
const fxProvider = "open.er-api.com";
class HotelBookingError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}
const configuration = () => {
  const supabaseUrl = process.env.VITE_SUPABASE_URL;
  const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseAnonKey || !serviceRoleKey) {
    throw new Error("Hotel booking database configuration is incomplete");
  }
  return { supabaseUrl: supabaseUrl.replace(/\/$/, ""), supabaseAnonKey, serviceRoleKey };
};
const serviceHeaders = (json = false) => {
  const { supabaseAnonKey, serviceRoleKey } = configuration();
  return {
    apikey: supabaseAnonKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    ...json ? { "content-type": "application/json" } : {}
  };
};
const readService = async (path2) => {
  const { supabaseUrl } = configuration();
  const response = await fetch(`${supabaseUrl}/rest/v1/${path2}`, { headers: serviceHeaders() });
  if (!response.ok) throw new Error("Unable to read hotel booking data");
  return response.json();
};
const writeService = async (path2, method, body, prefer = "return=minimal") => {
  const { supabaseUrl } = configuration();
  const response = await fetch(`${supabaseUrl}/rest/v1/${path2}`, {
    method,
    headers: { ...serviceHeaders(true), Prefer: prefer },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error("Unable to save hotel booking data");
  return response;
};
const callServiceRpc = async (name, args) => {
  const { supabaseUrl } = configuration();
  const response = await fetch(`${supabaseUrl}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: { ...serviceHeaders(true), Prefer: "return=representation" },
    body: JSON.stringify(args)
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message = payload && typeof payload.message === "string" ? payload.message : "Unable to create hotel reservation";
    throw new HotelBookingError(message, response.status >= 500 ? 503 : 400);
  }
  return payload;
};
const fetchAndStoreRates = async () => {
  const cached = await readService(
    "books_fx_rates?base_currency=eq.UGX&select=quote_currency,rate,fetched_at,stored_at,provider&order=stored_at.desc"
  );
  const mostRecent = cached[0]?.stored_at ? new Date(cached[0].stored_at).getTime() : 0;
  if (cached.length > 0 && Date.now() - mostRecent < 30 * 60 * 1e3) {
    return {
      rates: { UGX: 1, ...Object.fromEntries(cached.map((row) => [row.quote_currency.trim(), Number(row.rate)])) },
      asOf: cached[0].fetched_at,
      provider: cached[0].provider
    };
  }
  const response = await fetch("https://open.er-api.com/v6/latest/UGX", { signal: AbortSignal.timeout(8e3) });
  const payload = await response.json();
  if (!response.ok || payload.result !== "success" || !payload.rates || !payload.time_last_update_unix) {
    throw new Error("The exchange-rate service is temporarily unavailable");
  }
  const asOf = new Date(payload.time_last_update_unix * 1e3).toISOString();
  const rates = { ...payload.rates, UGX: 1 };
  const rows = Object.entries(rates).filter(([currency, rate]) => currency !== "UGX" && /^[A-Z]{3}$/.test(currency) && Number.isFinite(rate) && rate > 0).map(([currency, rate]) => ({ base_currency: "UGX", quote_currency: currency, rate, provider: fxProvider, fetched_at: asOf, stored_at: (/* @__PURE__ */ new Date()).toISOString() }));
  await writeService("books_fx_rates?on_conflict=base_currency,quote_currency", "POST", rows, "resolution=merge-duplicates,return=minimal");
  return { rates, asOf, provider: fxProvider };
};
const safeText = (value, maxLength) => typeof value === "string" ? value.trim().slice(0, maxLength) : "";
const getBooking = async (bookingId) => {
  const rows = await readService(`hotel_bookings?id=eq.${encodeURIComponent(bookingId)}&select=*`);
  if (!rows[0]) throw new HotelBookingError("Hotel reservation was not found", 404);
  return rows[0];
};
const getAttempt = async (txRef) => {
  const rows = await readService(`hotel_payment_attempts?tx_ref=eq.${encodeURIComponent(txRef)}&select=*`);
  if (!rows[0]) throw new HotelBookingError("Payment attempt was not found", 404);
  return rows[0];
};
const getReturnUrl = () => {
  const configuredUrl = process.env.FLUTTERWAVE_RETURN_URL;
  if (!configuredUrl) throw new Error("Flutterwave return URL is not configured");
  const url = new URL(configuredUrl);
  if (url.protocol !== "https:" || url.pathname !== "/checkout/flutterwave-return") {
    throw new Error("Flutterwave return URL must use HTTPS and target the payment return route");
  }
  url.searchParams.set("flow", "hotel");
  return url.toString();
};
const createBooking = async (request, response) => {
  try {
    const body = request.body;
    const email = safeText(body.guest?.email, 254).toLowerCase();
    if (!body.roomId || !/^[0-9a-f-]{36}$/i.test(body.roomId)) throw new HotelBookingError("Select a valid room");
    if (!body.checkIn || !/^\d{4}-\d{2}-\d{2}$/.test(body.checkIn) || !body.checkOut || !/^\d{4}-\d{2}-\d{2}$/.test(body.checkOut)) throw new HotelBookingError("Select valid check-in and check-out dates");
    if (!body.idempotencyKey || !/^[0-9a-f-]{36}$/i.test(body.idempotencyKey)) throw new HotelBookingError("Booking request is invalid");
    if (!body.accessToken || body.accessToken.length < 32 || body.accessToken.length > 256) throw new HotelBookingError("Booking access credential is invalid");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !Number.isInteger(body.guestCount) || !Number.isInteger(body.roomCount)) throw new HotelBookingError("Enter valid guest and room details");
    if (!Array.isArray(body.preferences) || body.preferences.some((value) => typeof value !== "string")) throw new HotelBookingError("Room preferences are invalid");
    const ratesSnapshot = await fetchAndStoreRates();
    const selectedRoom = (await readService(`hotel_rooms?id=eq.${encodeURIComponent(body.roomId)}&status=eq.published&select=currency_code`))[0];
    if (!selectedRoom) throw new HotelBookingError("This room is not available for booking", 404);
    const currency = selectedRoom.currency_code.trim().toUpperCase();
    if (!supportedCurrencies.has(currency) || !ratesSnapshot.rates[currency]) throw new HotelBookingError("This room uses an unsupported booking currency");
    const rows = await callServiceRpc(
      "create_hotel_booking",
      {
        target_room_id: body.roomId,
        target_guest: {
          first_name: safeText(body.guest?.firstName, 100),
          last_name: safeText(body.guest?.lastName, 100),
          email,
          phone: safeText(body.guest?.phone, 40)
        },
        target_check_in: body.checkIn,
        target_check_out: body.checkOut,
        target_guest_count: body.guestCount,
        target_room_count: body.roomCount,
        target_special_requests: safeText(body.specialRequests, 2e3),
        target_preferences: body.preferences,
        target_idempotency_key: body.idempotencyKey,
        target_access_token_hash: createHash("sha256").update(body.accessToken).digest("hex"),
        target_fx_rates: { ...ratesSnapshot.rates, as_of: ratesSnapshot.asOf, provider: ratesSnapshot.provider }
      }
    );
    const booking = rows[0];
    if (!booking) throw new Error("Reservation was not returned after creation");
    response.json({ ...booking, accessToken: body.accessToken, fxAsOf: ratesSnapshot.asOf });
  } catch (error) {
    response.status(error instanceof HotelBookingError ? error.status : 503).json({
      error: error instanceof Error ? error.message : "Unable to create hotel reservation"
    });
  }
};
const createPaymentSession = async (request, response) => {
  let txRef;
  try {
    const { bookingId, accessToken } = request.body;
    if (!bookingId || !accessToken) throw new HotelBookingError("Booking access is required");
    const booking = await getBooking(bookingId);
    const tokenHash = createHash("sha256").update(accessToken).digest("hex");
    if (tokenHash !== booking.access_token_hash) throw new HotelBookingError("Booking access could not be verified", 403);
    if (booking.payment_status === "paid") throw new HotelBookingError("This reservation is already paid", 409);
    if (booking.booking_status !== "pending" || !booking.expires_at || new Date(booking.expires_at).getTime() <= Date.now()) {
      throw new HotelBookingError("This reservation hold has expired. Select the room again to start a new booking.", 409);
    }
    const { supabaseUrl } = configuration();
    const activeResponse = await fetch(
      `${supabaseUrl}/rest/v1/hotel_payment_attempts?booking_id=eq.${encodeURIComponent(booking.id)}&status=in.(initiated,redirected)&select=id,booking_id,tx_ref,transaction_id,amount,currency_code,status,payment_url,created_at&order=created_at.desc&limit=1`,
      { headers: serviceHeaders() }
    );
    if (!activeResponse.ok) throw new Error("Unable to retrieve payment attempts");
    const [active] = await activeResponse.json();
    if (active?.status === "redirected" && active.payment_url) {
      response.json({ paymentUrl: active.payment_url, txRef: active.tx_ref, bookingId: booking.id });
      return;
    }
    if (active?.status === "initiated" && Date.now() - new Date(active.created_at).getTime() < 12e4) {
      throw new HotelBookingError("Secure checkout is being prepared. Try again in a moment.", 409);
    }
    if (active) await writeService(`hotel_payment_attempts?id=eq.${encodeURIComponent(active.id)}`, "PATCH", { status: "expired" });
    const secretKey = process.env.FLUTTERWAVE_SECRET_KEY;
    if (!secretKey) throw new Error("Flutterwave payment configuration is incomplete");
    txRef = `hotel-${booking.confirmation_number}-${randomUUID()}`;
    await writeService("hotel_payment_attempts", "POST", {
      booking_id: booking.id,
      tx_ref: txRef,
      amount: Number(booking.total_amount),
      currency_code: booking.currency_code,
      status: "initiated"
    });
    const currency = booking.currency_code.trim().toUpperCase();
    const flutterwaveResponse = await fetch(`${flutterwaveBaseUrl}/payments`, {
      method: "POST",
      headers: { Authorization: `Bearer ${secretKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        tx_ref: txRef,
        amount: Number(booking.total_amount),
        currency,
        payment_options: currency === "UGX" ? "card, mobilemoneyuganda" : "card",
        redirect_url: getReturnUrl(),
        customer: {
          email: booking.guest_email,
          name: `${booking.guest_first_name} ${booking.guest_last_name}`.trim(),
          phonenumber: booking.guest_phone
        },
        meta: { booking_id: booking.id, confirmation_number: booking.confirmation_number },
        customizations: { title: "Hotel Room Reservation", description: `Reservation ${booking.confirmation_number}` }
      }),
      signal: AbortSignal.timeout(15e3)
    });
    const payload = await flutterwaveResponse.json();
    if (!flutterwaveResponse.ok || payload.status !== "success" || !payload.data?.link) {
      throw new HotelBookingError("Flutterwave could not prepare secure checkout. Please try again.", 502);
    }
    await writeService(`hotel_payment_attempts?tx_ref=eq.${encodeURIComponent(txRef)}`, "PATCH", { status: "redirected", payment_url: payload.data.link });
    response.json({ paymentUrl: payload.data.link, txRef, bookingId: booking.id });
  } catch (error) {
    if (txRef) {
      await writeService(`hotel_payment_attempts?tx_ref=eq.${encodeURIComponent(txRef)}`, "PATCH", {
        status: "failed",
        failure_reason: error instanceof Error ? error.message.slice(0, 500) : "Unable to prepare payment"
      }).catch((failure) => console.error("Unable to record hotel payment failure", failure));
    }
    response.status(error instanceof HotelBookingError ? error.status : 503).json({
      error: error instanceof Error ? error.message : "Unable to prepare hotel payment"
    });
  }
};
const verifyTransaction = async (transactionId) => {
  const secretKey = process.env.FLUTTERWAVE_SECRET_KEY;
  if (!secretKey) throw new Error("Flutterwave payment configuration is incomplete");
  const response = await fetch(`${flutterwaveBaseUrl}/transactions/${encodeURIComponent(transactionId)}/verify`, {
    headers: { Authorization: `Bearer ${secretKey}` },
    signal: AbortSignal.timeout(15e3)
  });
  const payload = await response.json();
  if (!response.ok || payload.status !== "success" || !payload.data) throw new Error("Hotel payment could not be verified");
  return payload.data;
};
const verifyHotelPayment = async (transactionId, txRef, accessToken) => {
  const attempt = await getAttempt(txRef);
  const booking = await getBooking(attempt.booking_id);
  if (accessToken && createHash("sha256").update(accessToken).digest("hex") !== booking.access_token_hash) {
    throw new HotelBookingError("Booking access could not be verified", 403);
  }
  const transaction = await verifyTransaction(transactionId);
  if (transaction.status !== "successful" || transaction.tx_ref !== attempt.tx_ref || Number(transaction.amount) !== Number(booking.total_amount) || Number(transaction.amount) !== Number(attempt.amount) || transaction.currency.toUpperCase() !== booking.currency_code.trim().toUpperCase() || transaction.currency.toUpperCase() !== attempt.currency_code.trim().toUpperCase() || transaction.meta?.booking_id !== booking.id) throw new HotelBookingError("Payment verification did not match this reservation", 409);
  const result = await callServiceRpc(
    "confirm_hotel_booking_payment",
    { target_tx_ref: txRef, target_transaction_id: String(transaction.id) }
  );
  const confirmation = result[0];
  if (!confirmation) throw new Error("Confirmed hotel reservation was not returned");
  return confirmation;
};
const createHotelBooking = createBooking;
const createHotelPaymentSession = createPaymentSession;
const verifyHotelBookingPayment = async (request, response) => {
  try {
    const { transactionId, txRef, accessToken } = request.body;
    if (!transactionId || !txRef?.startsWith("hotel-") || !accessToken) throw new HotelBookingError("Payment verification details are required");
    const confirmation = await verifyHotelPayment(String(transactionId), txRef, accessToken);
    response.json({ ...confirmation, paymentStatus: confirmation.payment_status });
  } catch (error) {
    response.status(error instanceof HotelBookingError ? error.status : 503).json({
      error: error instanceof Error ? error.message : "Unable to confirm hotel payment"
    });
  }
};
const cancelHotelBookingPayment = async (request, response) => {
  try {
    const { txRef, status, accessToken } = request.body;
    if (!txRef?.startsWith("hotel-") || !["cancelled", "failed"].includes(status || "") || !accessToken) {
      throw new HotelBookingError("Payment cancellation details are invalid");
    }
    const attempt = await getAttempt(txRef);
    const booking = await getBooking(attempt.booking_id);
    if (createHash("sha256").update(accessToken).digest("hex") !== booking.access_token_hash) throw new HotelBookingError("Booking access could not be verified", 403);
    if (attempt.status !== "completed") {
      await writeService(`hotel_payment_attempts?tx_ref=eq.${encodeURIComponent(txRef)}`, "PATCH", {
        status: status === "cancelled" ? "cancelled" : "failed",
        ...status === "cancelled" ? { cancelled_at: (/* @__PURE__ */ new Date()).toISOString() } : { failure_reason: "Flutterwave returned an unsuccessful payment status" }
      });
    }
    response.json({ paymentStatus: status });
  } catch (error) {
    response.status(error instanceof HotelBookingError ? error.status : 503).json({
      error: error instanceof Error ? error.message : "Unable to record payment status"
    });
  }
};
const handleHotelBookingWebhook = async (request, response) => {
  const signature = request.headers["verif-hash"];
  const secretHash = process.env.FLUTTERWAVE_SECRET_HASH;
  if (!signature || !secretHash || signature !== secretHash) return response.status(401).end();
  const payload = request.body;
  if (payload.event !== "charge.completed" || !payload.data?.id || !payload.data.tx_ref?.startsWith("hotel-")) return response.status(200).end();
  try {
    await verifyHotelPayment(String(payload.data.id), payload.data.tx_ref);
    return response.status(200).end();
  } catch (error) {
    console.error("Hotel payment webhook verification failed", error);
    return response.status(500).end();
  }
};
const getExchangeRates = async (_request, response) => {
  try {
    const result = await fetchAndStoreRates();
    response.setHeader("Cache-Control", "private, max-age=300");
    response.json({ base: "UGX", rates: result.rates, asOf: result.asOf, provider: result.provider });
  } catch (error) {
    console.error("Unable to refresh Books exchange rates", error);
    response.status(503).json({ error: "Exchange rates are temporarily unavailable" });
  }
};
function createServer() {
  const app2 = express__default();
  app2.use(cors());
  app2.use(express__default.json());
  app2.use(express__default.urlencoded({ extended: true }));
  app2.get("/api/ping", (_req, res) => {
    res.json({ message: "Hello from Express server v2!" });
  });
  app2.get("/api/demo", handleDemo);
  app2.post("/api/payments/flutterwave/hosted-session", createFlutterwaveHostedSession);
  app2.post("/api/payments/flutterwave/cancel", cancelFlutterwavePayment);
  app2.post("/api/payments/flutterwave/verify", verifyFlutterwavePayment);
  app2.post("/api/payments/flutterwave/webhook", handleFlutterwaveWebhook);
  app2.post("/api/payments/special-events/session", prepareSpecialEventPayment);
  app2.post("/api/payments/special-events/verify", verifySpecialEventPayment);
  app2.post("/api/payments/special-events/cancel", cancelSpecialEventPayment);
  app2.post("/api/payments/special-events/webhook", handleSpecialEventWebhook);
  app2.post("/api/hotel-bookings/create", createHotelBooking);
  app2.post("/api/payments/hotel/session", createHotelPaymentSession);
  app2.post("/api/payments/hotel/verify", verifyHotelBookingPayment);
  app2.post("/api/payments/hotel/cancel", cancelHotelBookingPayment);
  app2.post("/api/payments/hotel/webhook", handleHotelBookingWebhook);
  app2.get("/api/books/fx-rates", getExchangeRates);
  return app2;
}
const app = createServer();
const port = process.env.PORT || 3e3;
const __dirname = import.meta.dirname;
const distPath = path.join(__dirname, "../spa");
app.use(express.static(distPath));
app.get("*", (req, res) => {
  if (req.path.startsWith("/api/") || req.path.startsWith("/health")) {
    return res.status(404).json({ error: "API endpoint not found" });
  }
  res.sendFile(path.join(distPath, "index.html"));
});
app.listen(port, () => {
  console.log(`🚀 Fusion Starter server running on port ${port}`);
  console.log(`📱 Frontend: http://localhost:${port}`);
  console.log(`🔧 API: http://localhost:${port}/api`);
});
process.on("SIGTERM", () => {
  console.log("🛑 Received SIGTERM, shutting down gracefully");
  process.exit(0);
});
process.on("SIGINT", () => {
  console.log("🛑 Received SIGINT, shutting down gracefully");
  process.exit(0);
});
//# sourceMappingURL=node-build.mjs.map
