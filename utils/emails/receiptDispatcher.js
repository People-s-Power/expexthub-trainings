// Fire-and-forget payment receipt dispatcher with an idempotency guard.
//
// The redirect-verification and the webhook can race for the same payment, and
// both finalizers re-run on replays. This helper guarantees at most one receipt
// per transaction by flipping `receiptEmailSentAt` with a conditional update,
// and it never lets a mail failure break the payment finalization it runs in.
const Course = require('../../models/courses.js');
const User = require('../../models/user.js');
const Transaction = require('../../models/transactions.js');
const { sendPaymentReceiptEmail } = require('./paymentReceiptEmail.js');

/**
 * Sends the payment receipt at most once for a given transaction.
 *
 * Sends first, then marks the transaction. If the mail fails the flag is left
 * clear so a later finalize (webhook retry) can re-attempt; if two calls race,
 * the conditional update ensures only one wins the flag.
 *
 * @param {Object} args
 * @param {Object} args.transaction - successful Transaction (doc or plain)
 * @param {Object} [args.user]       - recipient user { email, fullname }
 * @param {Object} [args.course]     - course { title } (fetched when omitted)
 * @param {Object} [args.plan]       - payment plan when this was an installment
 * @param {boolean} [args.settledInFull]
 * @param {number}  [args.balanceRemaining]
 * @param {string}  [args.paymentMethod]
 */
async function sendPaymentReceiptOnce({
  transaction,
  user,
  course,
  plan,
  settledInFull,
  balanceRemaining,
  paymentMethod,
}) {
  if (!transaction?._id) return false;

  try {
    // Already delivered for this transaction? Drop out early.
    if (transaction.receiptEmailSentAt) return false;

    // Resolve the pieces we need to address and describe the email.
    let recipient = user;
    if (!recipient) recipient = await User.findById(transaction.userId).select('email fullname').lean();
    if (!recipient?.email) return false;

    let courseDoc = course;
    if (!courseDoc && transaction.courseId) {
      courseDoc = await Course.findById(transaction.courseId).select('title').lean();
    }

    await sendPaymentReceiptEmail({
      user: recipient,
      transaction,
      course: courseDoc,
      plan,
      settledInFull,
      balanceRemaining,
      paymentMethod,
    });

    // Mark as sent on the stored row only. The conditional filter makes two
    // racing callers safe: whichever updates first wins; the loser gets 0.
    const result = await Transaction.updateOne(
      { _id: transaction._id, receiptEmailSentAt: { $exists: false } },
      { $set: { receiptEmailSentAt: new Date() } },
    );
    if (transaction.receiptEmailSentAt === undefined && transaction.toObject) {
      transaction.receiptEmailSentAt = new Date();
    }
    return result.modifiedCount > 0;
  } catch (error) {
    console.error('Payment receipt email failed:', error.message);
    return false;
  }
}

module.exports = {
  sendPaymentReceiptOnce,
};
