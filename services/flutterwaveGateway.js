// Thin wrapper over Flutterwave's charge-verification endpoints.
//
// The redirect verifier, the webhook, and the reconciliation sweep all need to
// confirm a charge the same way. Extracting it here means there is one place that
// knows how to look a charge up (by gateway id when we have one, by our own
// reference otherwise) and one definition of "does this charge match what we
// recorded", instead of three copies drifting apart.
const axios = require('axios');

const flutterwaveBaseURL = 'https://api.flutterwave.com/v3/';
const flutterwaveSecretKey = process.env.FLUTTERWAVE_SECRET;
const flwHeaders = { Authorization: `Bearer ${flutterwaveSecretKey}` };
const GATEWAY_TIMEOUT_MS = 20000;

/**
 * Verifies a charge with Flutterwave.
 *
 * Prefers the gateway transaction id (the Standard redirect carries it) and falls
 * back to our own reference, so confirmation never dead-ends just because the id
 * was not echoed back.
 *
 * Returns { ok, payment, notFound }:
 *   - ok:       Flutterwave answered `status: 'success'` (the lookup itself worked)
 *   - payment:  the `data` object Flutterwave returned (may be undefined)
 *   - notFound: the charge does not exist at the gateway yet (HTTP 404) — genuinely
 *               pending rather than an outage, so a caller can keep polling.
 * Any other transport error is rethrown, so a caller treats it as temporary.
 */
async function verifyCharge({ gatewayTransactionId, txRef }) {
  try {
    const response = gatewayTransactionId
      ? await axios.get(`${flutterwaveBaseURL}transactions/${encodeURIComponent(gatewayTransactionId)}/verify`, {
          headers: flwHeaders,
          timeout: GATEWAY_TIMEOUT_MS,
        })
      : await axios.get(`${flutterwaveBaseURL}transactions/verify_by_reference`, {
          params: { tx_ref: txRef },
          headers: flwHeaders,
          timeout: GATEWAY_TIMEOUT_MS,
        });
    return { ok: response.data?.status === 'success', payment: response.data?.data, notFound: false };
  } catch (error) {
    if (error.response?.status === 404) return { ok: false, payment: null, notFound: true };
    throw error;
  }
}

/**
 * True only when the gateway's charge matches the transaction we recorded: the
 * reference, an amount at least what we charged (an overpayment still settles
 * rather than stranding the payer), and the currency. A matching reference alone
 * is never enough — the amount and currency must agree too.
 *
 * This is only the payment-vs-record cross-check; callers combine it with the
 * `ok` flag from verifyCharge (that the lookup itself succeeded).
 */
function isChargeConfirmed(payment, transaction) {
  return Boolean(
    payment
    && payment.status === 'successful'
    && payment.tx_ref === transaction.txRef
    && Number(payment.amount) >= Number(transaction.amount)
    && payment.currency === transaction.currency,
  );
}

module.exports = { verifyCharge, isChargeConfirmed };
