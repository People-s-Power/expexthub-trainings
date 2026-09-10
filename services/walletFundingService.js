// Wallet-funding settlement.
//
// Extracted from the HTTP controller so the webhook, the redirect verifier, and
// the reconciliation sweep can all finalize a funding the same way — mirroring
// how the course finalizers live in coursePaymentService.js, and how withdrawal
// settlement lives in withdrawalService.js. The cron reuses this without pulling
// in the controller.
const Transaction = require('../models/transactions.js');
const User = require('../models/user.js');

/**
 * Finalizes a wallet-funding payment: flips the still-pending Transaction to
 * successful and credits the wallet once.
 *
 * Idempotency comes from the conditional status update — only the first caller
 * (webhook, redirect verification, or the reconciliation sweep) whose filter
 * still matches performs the write, and only that winner increments the balance.
 * Replays no-op.
 *
 * The amount/currency cross-check against Flutterwave happens in the caller
 * before this is invoked.
 */
async function finalizeWalletFunding(txRef, gatewayPayment) {
  const transaction = await Transaction.findOne({ txRef });
  if (!transaction || transaction.type !== 'wallet_funding') {
    console.error('Wallet funding: transaction not found for', txRef);
    return false;
  }

  const updated = await Transaction.findOneAndUpdate(
    { _id: transaction._id, status: 'pending' },
    {
      $set: {
        status: 'successful',
        paidAt: transaction.paidAt || new Date(),
        ...(gatewayPayment?.id ? { gatewayTransactionId: String(gatewayPayment.id) } : {}),
      },
    },
    { new: true },
  );
  if (!updated) return true; // Already finalized (webhook/redirect replay).

  const user = await User.findById(updated.userId);
  if (!user) {
    console.error('Wallet funding: user not found for', String(updated.userId), 'txRef', txRef);
    return true;
  }

  const preCredit = Number(user.balance) || 0;
  const credited = await User.findByIdAndUpdate(
    updated.userId,
    { $inc: { balance: Number(updated.amount) } },
    { new: true },
  );
  // Record the running balance so the ledger reconciles line-by-line.
  await Transaction.updateOne({ _id: updated._id }, { $set: { balanceAfter: preCredit + Number(updated.amount) } });

  console.log('Wallet funded:', txRef, 'amount', updated.amount, 'balanceAfter', credited?.balance);
  return true;
}

module.exports = { finalizeWalletFunding };
