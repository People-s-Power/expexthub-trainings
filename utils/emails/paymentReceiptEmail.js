// Course payment receipt email.
//
// Emitted when a course payment clears (full, installment, or wallet) so the
// student has a durable confirmation containing the amount, reference and next
// steps. Full and installment flows funnel through finalize* functions in
// services/coursePaymentService.js, so the hook lives there; the wallet full
// payment path is a direct writer in transactionController.js.
const {
  sendMail,
  renderLayout,
  plainTextFallback,
  formatNaira,
  formatDate,
} = require('./mailer.js');

const brandHomeUrl = (process.env.FRONTEND_URL || 'https://experthubllc.com').replace(/\/$/, '');
const trainingUrl = (process.env.TRAINING_URL || 'https://trainings.experthubllc.com').replace(/\/$/, '');
const logoUrl = `${trainingUrl}/images/logo.png`;
const supportEmail = process.env.MAIL_SUPPORT_EMAIL || 'support@experthubllc.com';

function firstNameOf(fullname) {
  if (!fullname) return 'there';
  const first = String(fullname).trim().split(/\s+/)[0];
  return first || 'there';
}

// The public course detail page is composed client-side from a category slug
// plus the course id, so the server cannot reliably reconstruct it here. The
// student dashboard is the destination that always works after enrollment.
function studentCtaUrl(isInstallment, isFullySettled) {
  if (isInstallment && !isFullySettled) return `${trainingUrl}/applicant/payment-plans`;
  return `${trainingUrl}/applicant`;
}

/**
 * Sends a payment receipt to the student.
 *
 * @param {Object} opts
 * @param {Object} opts.user   - { email, fullname }
 * @param {Object} opts.transaction - the successful Transaction document
 * @param {Object} [opts.course]    - Course doc (title, slug)
 * @param {Object} [opts.plan]      - payment plan, when this is an installment
 * @param {string} [opts.amountPaid] - already-formatted major-unit amount if known
 * @param {boolean} [opts.settledInFull] - whether this clears the whole balance
 * @param {number} [opts.balanceRemaining] - outstanding major units after this payment
 * @param {string} [opts.paymentMethod]    - e.g. 'Card', 'Bank Transfer', 'Wallet'
 */
async function sendPaymentReceiptEmail({
  user,
  transaction,
  course,
  plan,
  amountPaid,
  settledInFull,
  balanceRemaining,
  paymentMethod,
}) {
  if (!user?.email || !transaction) {
    throw new Error('Receipt recipient and transaction are required');
  }

  const type = String(transaction.type || '');
  const isWallet = type.includes('wallet');
  const isInstallment = type === 'course_installment' || type === 'course_installment_wallet';
  const method = paymentMethod || (isWallet ? 'Wallet' : isInstallment ? 'Part payment' : 'Card / Bank transfer');

  const courseTitle = course?.title
    || transaction.metadata?.title
    || plan?.priceSnapshot?.courseTitle
    || 'your course';

  // Amount. `amountPaid` is provided by the finalizers as the major-unit figure;
  // otherwise fall back to the transaction's stored amount.
  const paid = formatNaira(amountPaid !== undefined ? amountPaid : transaction.amount);
  const remaining = balanceRemaining !== undefined && balanceRemaining > 0
    ? formatNaira(balanceRemaining)
    : null;

  const isFullySettled = settledInFull === true || (!isInstallment && !remaining);

  const installmentNote = isInstallment && !isFullySettled
    ? `This is a part payment. You can continue paying down your balance from your dashboard.`
    : null;

  const heading = isFullySettled
    ? 'Enrollment confirmed!'
    : 'Part payment received';

  const data = {
    subject: isFullySettled
      ? `You're enrolled in ${courseTitle}`
      : `Part payment received for ${courseTitle}`,
    preheader: isFullySettled
      ? `Payment confirmed. Welcome to ${courseTitle}.`
      : `We received your part payment for ${courseTitle}.`,
    firstName: firstNameOf(user.fullname),
    emailHeading: heading,
    amountPaid: paid,
    courseTitle,
    txRef: transaction.txRef || '—',
    paidAt: formatDate(transaction.paidAt || transaction.date || new Date()),
    paymentMethod: method,
    installmentNote,
    balanceRemaining: remaining,
    settlementDueAt: plan?.settlementDueAt ? formatDate(plan.settlementDueAt) : '',
    ctaUrl: studentCtaUrl(isInstallment, isFullySettled),
    ctaLabel: isFullySettled ? 'Go to my dashboard' : 'View my balance',
    showSupport: true,
    brandHomeUrl,
    logoUrl,
    supportEmail,
    email: user.email,
  };

  const html = renderLayout('payment-receipt', data);
  const text = plainTextFallback([
    `Hi ${data.firstName},`,
    heading,
    `Amount paid: ${paid}`,
    `Course: ${courseTitle}`,
    `Reference: ${transaction.txRef || '—'}`,
    isInstallment && !isFullySettled
      ? `This is a part payment${remaining ? `. Remaining balance: ${remaining}` : ''}.`
      : null,
    isInstallment && !isFullySettled && plan?.settlementDueAt
      ? `Please clear your balance by ${data.settlementDueAt} to keep your access active.`
      : null,
    `Questions? Reply to this email or contact ${supportEmail}.`,
    'The Experthub Trainings Team',
  ]);

  return sendMail({
    to: user.email,
    subject: data.subject,
    html,
    text,
    replyTo: supportEmail,
  });
}

module.exports = {
  sendPaymentReceiptEmail,
  studentCtaUrl,
  firstNameOf,
  brandHomeUrl,
  trainingUrl,
  logoUrl,
  supportEmail,
};
