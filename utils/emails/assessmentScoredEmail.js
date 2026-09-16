// Assessment scored email.
//
// Emitted once, when a provider grades a completed assessment from the Scoring
// modal. Sent from updateScore in controllers/accessmentController.js, and only
// on the ungraded -> graded transition: providers can reopen the modal to
// correct a score, and without that guard every correction would re-email the
// student.
//
// The View Score button points at /applicant/result/<id>, the page built for
// this email. That page reads a scoped endpoint that returns only the calling
// student's own response.
const {
  sendMail,
  renderLayout,
  plainTextFallback,
  formatDate,
} = require('./mailer.js');
const { typeLabel, firstNameOf } = require('./assessmentAssignedEmail.js');

const brandHomeUrl = (process.env.FRONTEND_URL || 'https://experthubllc.com').replace(/\/$/, '');
const trainingUrl = (process.env.TRAINING_URL || 'https://trainings.experthubllc.com').replace(/\/$/, '');
const logoUrl = `${trainingUrl}/images/logo.png`;
const supportEmail = process.env.MAIL_SUPPORT_EMAIL || 'support@experthubllc.com';

function studentResultUrl(assessment) {
  const id = assessment?._id || assessment?.id || '';
  return `${trainingUrl}/applicant/result/${id}`;
}

/** "7 / 10" when the question count is known, otherwise just the raw score. */
function scoreLabel(score, total) {
  const value = Number(score);
  if (!Number.isFinite(value)) return '—';
  const rounded = Math.round(value * 100) / 100;
  return total ? `${rounded} / ${total}` : String(rounded);
}

/** Whole-number percentage when both figures are usable, else null. */
function percentLabel(score, total) {
  const value = Number(score);
  const count = Number(total);
  if (!Number.isFinite(value) || !Number.isFinite(count) || count <= 0) return null;
  return `${Math.round((value / count) * 100)}%`;
}

/**
 * Sends the "your assessment has been graded" email.
 *
 * @param {Object} opts
 * @param {Object} opts.student    - { email, fullname }
 * @param {Object} opts.assessment - the Assessment document
 * @param {number} opts.score      - the score the provider entered
 */
async function sendAssessmentScoredEmail({ student, assessment, score }) {
  if (!student?.email || !assessment) {
    throw new Error('Result email needs a recipient and an assessment');
  }

  const assessmentTitle = assessment.title || 'Assessment';
  const total = Array.isArray(assessment.assesment) ? assessment.assesment.length : 0;

  const data = {
    subject: `Your result for ${assessmentTitle}`,
    preheader: `You scored ${scoreLabel(score, total)} on ${assessmentTitle}.`,
    firstName: firstNameOf(student.fullname),
    assessmentTitle,
    assessmentType: typeLabel(assessment.type),
    scoreLabel: scoreLabel(score, total),
    percentage: percentLabel(score, total) || '',
    gradedAt: formatDate(new Date()),
    ctaUrl: studentResultUrl(assessment),
    ctaLabel: 'View Score',
    brandHomeUrl,
    logoUrl,
    supportEmail,
    email: student.email,
  };

  const html = renderLayout('assessment-scored', data);
  const text = plainTextFallback([
    `Hi ${data.firstName},`,
    `You have completed ${assessmentTitle}.`,
    `Your score: ${data.scoreLabel}${data.percentage ? ` (${data.percentage})` : ''}`,
    `View your result here: ${data.ctaUrl}`,
    'The Experthub Trainings Team',
  ]);

  return sendMail({
    to: student.email,
    subject: data.subject,
    html,
    text,
    replyTo: supportEmail,
  });
}

module.exports = {
  sendAssessmentScoredEmail,
  studentResultUrl,
  scoreLabel,
  percentLabel,
};
