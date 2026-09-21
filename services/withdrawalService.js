// Withdrawal (payout) settlement.
//
// Flutterwave transfers are asynchronous: `POST /transfers` only QUEUES a payout,
// and the real outcome arrives later as a `transfer.completed` webhook. The wallet
// is debited up front as a hold when the withdrawal is requested; this module is
// the single place that later confirms the payout (leaving the debit in place) or
// releases the hold (crediting the amount back) — via the webhook, the redirect
// settle path, or the reconciliation sweep. Every settle here is idempotent, so
// those three can overlap without ever double-crediting.
//
// This mirrors coursePaymentService.js: the money logic lives in a service the
// controller orchestrates over HTTP, and the cron reuses it without pulling the
// controller in.
const axios = require('axios');
const crypto = require('crypto');
const Transaction = require('../models/transactions.js');
const User = require('../models/user.js');
const PaymentWebhookEvent = require('../models/paymentWebhookEvents.js');

const flutterwaveBaseURL = 'https://api.flutterwave.com/v3/';
const flutterwaveSecretKey = process.env.FLUTTERWAVE_SECRET;
const flwHeaders = { Authorization: `Bearer ${flutterwaveSecretKey}` };

// A withdrawal runs its gateway calls inside the HTTP request. Keep the entire
// synchronous portion well below an upstream's shortest timeout: a transfer that
// takes longer is safely left pending and settled by its webhook/reconciler. This
// prevents a slow bank response from turning a correctly queued withdrawal into a
// 504 at the browser.
const TRANSFER_TIMEOUT_MS = 4500;
const STATUS_TIMEOUT_MS = 2500;
const REQUEST_BUDGET_MS = 7500;

// The reconciliation sweep has no proxy in front of it and would rather resolve a
// withdrawal than defer it, so it keeps a more patient timeout than a request can.
const RECONCILE_TIMEOUT_MS = 20000;

// How long a withdrawal may sit in `pending` before the reconciliation sweep
// actively checks it against the gateway. Kept comfortably longer than a normal
// transfer + webhook round-trip so the sweep only ever touches genuinely stuck rows.
const WITHDRAWAL_RECONCILE_AFTER_MS = 15 * 60 * 1000;

// Terminal transfer states as Flutterwave reports them (uppercase, unlike the
// lowercase status on a charge). SUCCESSFUL confirms the payout reached the bank;
// the failure family means the money did not leave (or was reversed), so the
// wallet hold is released. Any other value (NEW/PENDING) is still in flight.
const TRANSFER_SUCCESS = 'SUCCESSFUL';
const TRANSFER_FAILURES = ['FAILED', 'FAILED_FUNDS', 'FAILED_DISBURSE', 'REVERSED', 'CANCELLED'];

/** A ledger row is a withdrawal only if it is the debit hold we created for one. */
function isWithdrawal(transaction) {
  return Boolean(
    transaction
    && transaction.type === 'debit'
    && transaction.metadata?.purpose === 'withdrawal',
  );
}

// How long after requesting a withdrawal a second one is refused. Deliberately
// short: the case this guards is the user seeing the request fail and pressing
// "Withdraw" again seconds later, while the first hold is still on the wallet.
// Refusing on *any* pending row instead would lock the user out for the whole
// reconciler grace window — up to ~25 minutes — with only a 409 to explain it.
const DUPLICATE_WITHDRAWAL_WINDOW_MS = 2 * 60 * 1000;

/**
 * Finds a withdrawal this user requested within the last `withinMs`, if any.
 *
 * The wallet is debited before the gateway is contacted, so a user whose request
 * errored has already been charged. Without this check a second click would queue
 * a second real transfer on top of a hold that may already be paying out.
 */
async function findPendingWithdrawal(userId, withinMs = DUPLICATE_WITHDRAWAL_WINDOW_MS) {
  return Transaction.findOne({
    userId,
    type: 'debit',
    status: 'pending',
    'metadata.purpose': 'withdrawal',
    date: { $gte: new Date(Date.now() - withinMs) },
  });
}

/**
 * Applies a transfer's terminal outcome to its withdrawal exactly once.
 *
 * The wallet was already debited when the withdrawal was requested, so SUCCESSFUL
 * only flips the ledger row to successful, while a failure releases the hold by
 * crediting the amount back. The refund is gated by the same pending->failed
 * transition that authorizes it: only the caller that wins that conditional update
 * credits the wallet, so a replayed webhook, the redirect settle path, and the
 * reconciliation sweep can never double-refund.
 *
 * Returns 'successful' | 'refunded' | 'pending'.
 */
async function reconcileWithdrawalOutcome(transaction, status, data) {
  const normalized = String(status || '').toUpperCase();

  if (normalized === TRANSFER_SUCCESS) {
    await Transaction.updateOne(
      { _id: transaction._id, status: 'pending' },
      {
        $set: {
          status: 'successful',
          paidAt: new Date(),
          ...(data?.id ? { gatewayTransactionId: String(data.id) } : {}),
        },
      },
    );
    return 'successful';
  }

  if (TRANSFER_FAILURES.includes(normalized)) {
    const failed = await Transaction.findOneAndUpdate(
      { _id: transaction._id, status: 'pending' },
      { $set: { status: 'failed' } },
      { new: true },
    );
    if (failed) {
      await User.findByIdAndUpdate(transaction.userId, { $inc: { balance: Number(transaction.amount) } });
    }
    return 'refunded';
  }

  return 'pending';
}

/**
 * Resolves an ambiguous transfer failure (a timeout or 5xx on `POST /transfers`,
 * where the gateway may still have accepted the transfer) without paying out
 * twice, by looking the transfer up by reference.
 *
 * A confirmed terminal state is applied through reconcileWithdrawalOutcome.
 * Anything still in flight keeps the hold so the webhook or a later sweep can
 * finish it.
 *
 * A reference with no transfer row only proves the transfer was never created
 * once the gateway's list has caught up with its own writes — see
 * `allowRefundOnMissing`.
 *
 * `timeoutMs` defaults to the sweep's patient value; a caller running inside an
 * HTTP request passes a tighter one so the lookup cannot outlive the platform's
 * proxy timeout.
 *
 * Returns 'successful' | 'refunded' | 'pending'.
 */
async function settleAmbiguousTransfer(userId, transaction, amount, reference, timeoutMs = RECONCILE_TIMEOUT_MS, allowRefundOnMissing = true) {
  try {
    const statusResponse = await axios.get(`${flutterwaveBaseURL}transfers`, {
      params: { reference },
      headers: flwHeaders,
      timeout: timeoutMs,
    });
    const rows = statusResponse.data?.data;
    const transfer = Array.isArray(rows) ? rows.find((row) => row?.reference === reference) : null;

    if (!transfer) {
      // No transfer row for this reference. Conclusive only outside the window in
      // which the gateway's list can lag its own writes: a transfer accepted
      // moments ago may not be listed yet, and refunding on that reading would pay
      // the user twice — once by the bank, once by us. A request-time caller passes
      // allowRefundOnMissing=false and keeps the hold instead; the sweep runs well
      // past that window and is the one that decides.
      if (!allowRefundOnMissing) return 'pending';

      const failed = await Transaction.findOneAndUpdate(
        { _id: transaction._id, status: 'pending' },
        { $set: { status: 'failed' } },
        { new: true },
      );
      if (failed) await User.findByIdAndUpdate(userId, { $inc: { balance: amount } });
      return 'refunded';
    }

    return reconcileWithdrawalOutcome(transaction, transfer.status, transfer);
  } catch (error) {
    console.error('Withdrawal status check failed:', error.response?.data || error.message);
    return 'pending';
  }
}

/**
 * Processes a Flutterwave transfer webhook (`transfer.completed` etc.).
 *
 * Dedupe uses PaymentWebhookEvent with a transfer-namespaced id so a transfer id
 * cannot collide with a charge id. Reconciliation is idempotent on its own, so a
 * replay past the dedupe is still harmless. Re-throws on unexpected failure so the
 * caller can return 500 and let Flutterwave retry.
 *
 * Returns 'ok' | 'duplicate' | 'ignored'.
 */
async function handleTransferEvent(body) {
  const data = body?.data || {};
  const reference = data.reference;
  if (!reference && !data.id) return 'ignored';
  const eventId = data.id ? `flutterwave-transfer-${data.id}` : `flutterwave-transfer-${reference}`;

  let event;
  try {
    // Claim the event atomically; a duplicate delivery loses on the unique index.
    try {
      event = await PaymentWebhookEvent.create({ eventId, payload: body, status: 'received' });
    } catch (createError) {
      if (createError?.code !== 11000) throw createError;
      const existing = await PaymentWebhookEvent.findOne({ eventId });
      if (existing?.status === 'processed') return 'duplicate';
      // A prior attempt failed mid-flight; retry it. Reconciliation is idempotent.
      event = existing;
    }

    if (reference) {
      const withdrawal = await Transaction.findOne({ reference, type: 'debit' });
      if (isWithdrawal(withdrawal)) {
        await reconcileWithdrawalOutcome(withdrawal, data.status, data);
      }
    }

    if (event) {
      event.status = 'processed';
      event.processedAt = new Date();
      await event.save();
    }
    return 'ok';
  } catch (error) {
    if (event) {
      event.status = 'failed';
      event.error = error.message;
      await event.save().catch((saveError) => console.error('Could not persist transfer webhook failure:', saveError));
    }
    throw error;
  }
}

/**
 * Safety net for withdrawals whose transfer webhook never arrived (endpoint
 * downtime, misconfiguration, dropped delivery). Sweeps withdrawals stuck in
 * `pending` past the grace window and settles each against the gateway, so money
 * is never held indefinitely and a failed payout is always refunded. Every settle
 * is idempotent, so overlapping with a late webhook is safe.
 */
async function reconcilePendingWithdrawals({ olderThanMs = WITHDRAWAL_RECONCILE_AFTER_MS, limit = 100 } = {}) {
  const cutoff = new Date(Date.now() - olderThanMs);
  const stuck = await Transaction.find({
    type: 'debit',
    status: 'pending',
    'metadata.purpose': 'withdrawal',
    date: { $lte: cutoff },
  }).limit(limit);

  let settled = 0;
  let refunded = 0;
  for (const withdrawal of stuck) {
    const reference = withdrawal.reference || withdrawal.txRef;
    if (!reference) continue;
    const outcome = await settleAmbiguousTransfer(
      withdrawal.userId,
      withdrawal,
      Number(withdrawal.amount),
      reference,
    );
    if (outcome === 'successful') settled += 1;
    if (outcome === 'refunded') refunded += 1;
  }
  if (stuck.length) {
    console.log(`Withdrawal reconciliation: checked ${stuck.length}, settled ${settled}, refunded ${refunded}.`);
  }
  return { checked: stuck.length, settled, refunded };
}

/**
 * Debits the wallet and queues the payout. The single place a withdrawal is
 * started, whether a user pressed "Withdraw" or a scheduled auto payout fired,
 * so both triggers share one hold-then-transfer contract and one refund path.
 *
 * `source` is recorded on the ledger row only — it never changes the money logic.
 *
 * Returns one of:
 *   'successful'   payout confirmed by the gateway in the synchronous response
 *   'queued'       accepted and in flight; the webhook or sweep finalizes it
 *   'refunded'     rejected outright, hold released, balance untouched overall
 *   'insufficient' nothing was debited
 *   'no_account'   no payout bank saved
 *   'in_progress'  a withdrawal was requested moments ago; nothing was debited
 */
async function executeWithdrawal({ user, amount, source = 'manual', narration = 'Withdrawal' }) {
  if (!user?.bankCode || !user?.accountNumber) {
    return { outcome: 'no_account', message: 'Please add your payout bank account first' };
  }

  const userId = user._id;

  // Refuse a near-immediate retry. The debit below happens before the gateway is
  // contacted, so a user whose request just errored has already been charged —
  // without this, the click they make on seeing that error queues a second real
  // transfer on top of the first.
  const inFlight = await findPendingWithdrawal(userId);
  if (inFlight) {
    return {
      outcome: 'in_progress',
      message: 'A withdrawal is already being processed. Please check your transaction history before trying again.',
    };
  }

  // Debit first, conditionally on sufficient funds, so two concurrent
  // withdrawals (or a manual one racing the scheduler) cannot both pass a
  // balance check and overdraw.
  const debited = await User.findOneAndUpdate(
    { _id: userId, balance: { $gte: amount } },
    { $inc: { balance: -amount } },
    { new: true },
  );
  if (!debited) {
    return { outcome: 'insufficient', message: 'Insufficient balance' };
  }

  const reference = `wd-${crypto.randomUUID()}`;
  const transaction = await Transaction.create({
    userId,
    amount,
    type: 'debit',
    direction: 'debit',
    balanceAfter: debited.balance,
    status: 'pending',
    txRef: reference,
    reference,
    metadata: {
      purpose: 'withdrawal',
      source,
      accountName: user.accountName || null,
      bankCode: user.bankCode,
      accountNumber: user.accountNumber,
    },
  });

  // Everything past this point has to fit the request's time budget.
  const startedAt = Date.now();

  try {
    const response = await axios.post(`${flutterwaveBaseURL}transfers`, {
      account_bank: user.bankCode,
      account_number: user.accountNumber,
      amount,
      narration,
      currency: 'NGN',
      reference,
    }, { headers: flwHeaders, timeout: TRANSFER_TIMEOUT_MS });

    if (response.data?.status !== 'success') {
      throw new Error(response.data?.message || 'Transfer was not accepted');
    }

    // `POST /transfers` only QUEUES the payout; Flutterwave confirms the real
    // outcome asynchronously via the transfer webhook. The wallet is already
    // debited as a hold, so record the gateway id and keep the withdrawal
    // pending until the webhook (or the reconciliation sweep) settles it —
    // marking it successful here would strand the user if the payout later
    // failed at the bank, with no event to trigger a refund.
    const transfer = response.data?.data;
    if (transfer?.id) {
      await Transaction.updateOne({ _id: transaction._id }, { $set: { gatewayTransactionId: String(transfer.id) } });
    }

    const transferStatus = String(transfer?.status || '').toUpperCase();
    if (transferStatus === TRANSFER_SUCCESS) {
      // Some rails settle instantly and report it right in the response.
      await Transaction.updateOne(
        { _id: transaction._id, status: 'pending' },
        { $set: { status: 'successful', paidAt: new Date() } },
      );
      return { outcome: 'successful', message: 'Withdrawal successful', transactionId: transaction._id };
    }
    if (TRANSFER_FAILURES.includes(transferStatus)) {
      const outcome = await reconcileWithdrawalOutcome(transaction, transferStatus, transfer);
      return {
        outcome: outcome === 'refunded' ? 'refunded' : 'queued',
        message: 'Withdrawal could not be completed. Your balance was not affected.',
        transactionId: transaction._id,
      };
    }

    // Queued (NEW/PENDING): the transfer webhook finalizes or refunds it.
    return {
      outcome: 'queued',
      message: 'Your withdrawal is being processed. It will reflect shortly.',
      transactionId: transaction._id,
    };
  } catch (transferError) {
    // A timeout or 5xx does not prove the transfer failed — the gateway may have
    // accepted it and lost the response on the way back, in which case refunding
    // the hold would pay the amount out twice. Resolve by reference first.
    console.error('Withdrawal transfer failed:', transferError.response?.data || transferError.message);

    // ...but only while the request can still afford it. If the transfer attempt
    // already ate the budget, defer to the webhook and the sweep rather than push
    // the handler past the platform's proxy timeout — that timeout is what showed
    // users a gateway error page over a hold that had already been taken.
    if (Date.now() - startedAt + STATUS_TIMEOUT_MS > REQUEST_BUDGET_MS) {
      return {
        outcome: 'queued',
        message: 'Your withdrawal is being processed. It will reflect shortly.',
        transactionId: transaction._id,
      };
    }

    // allowRefundOnMissing=false: a "not found" taken this soon after the attempt
    // may just be the gateway's list lagging behind its own writes, so the hold is
    // kept and the sweep — which runs well past that window — decides the refund.
    const settled = await settleAmbiguousTransfer(userId, transaction, amount, reference, STATUS_TIMEOUT_MS, false);
    if (settled === 'successful') {
      return { outcome: 'successful', message: 'Withdrawal successful', transactionId: transaction._id };
    }
    if (settled === 'refunded') {
      return {
        outcome: 'refunded',
        message: 'Withdrawal could not be completed. Your balance was not affected.',
        transactionId: transaction._id,
      };
    }
    // Still settling at the gateway: keep the hold and let reconciliation finish
    // it rather than risking a double payout.
    return {
      outcome: 'queued',
      message: 'Your withdrawal is being processed. It will reflect shortly.',
      transactionId: transaction._id,
    };
  }
}

module.exports = {
  TRANSFER_SUCCESS,
  TRANSFER_FAILURES,
  WITHDRAWAL_RECONCILE_AFTER_MS,
  DUPLICATE_WITHDRAWAL_WINDOW_MS,
  isWithdrawal,
  findPendingWithdrawal,
  executeWithdrawal,
  reconcileWithdrawalOutcome,
  settleAmbiguousTransfer,
  handleTransferEvent,
  reconcilePendingWithdrawals,
};
