// Assessment completed email.
//
// Emitted when a student submits an assessment, addressed to the people
// responsible for it: the assessment's own tutor (who created it) and the
// provider who onboarded the student (`User.registeredBy`, set by the
// admissions flow), when those are two different accounts. Distinct from
// assessmentScoredEmail.js, which goes the other way — to the student, once a
// provider has graded the submission.
//
// One mail per recipient rather than a single message with everyone in `To:`:
// the recipients are separate businesses and should not see each other's
// addresses.
//
// Sent from submitAssessment in controllers/accessmentController.js, through
// sendAssessmentEmailSafely so a mailer problem can never fail a submission
// that is already saved.
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

/**
 * The provider-facing responses page for one assessment.
 *
 * /tutor/assesment/view?page=<id> renders every submission for the assessment
 * with the scoring control on each, which is where "view his score" has to land
 * — there is no per-student score page on the provider side. Admins get the
 * same page under their own dashboard, which is the only other prefix that
 * ships an `assesment/view` route.
 */
function providerAssessmentUrl(assessment, viewer) {
  const id = assessment?._id || assessment?.id || '';
  const prefix = viewer?.role === 'admin' ? '/admin' : '/tutor';
  return `${trainingUrl}${prefix}/assesment/view?page=${id}`;
}

/**
 * Emails the provider and instructor that a student has completed an assessment.
 *
 * @param {Object}   opts
 * @param {Object}   opts.assessment - the Assessment document
 * @param {Object}   opts.student    - the submitting student ({ fullname })
 * @param {Object[]} opts.recipients - provider/instructor users to notify
 * @returns {Promise<Object[]>} one settled result per recipient
 */
async function sendAssessmentCompletedEmail({ assessment, student, recipients }) {
  if (!assessment) {
    throw new Error('Completion email needs an assessment');
  }

  const assessmentTitle = assessment.title || 'Assessment';
  const questionCount = Array.isArray(assessment.assesment) ? assessment.assesment.length : 0;
  const studentName = student?.fullname || 'A student';
  const submittedAt = formatDate(new Date());

  // De-duplicated and stripped of anyone without an address: the same person can
  // be both the assessment's tutor and the student's provider, and a
  // provider-created student always has `registeredBy` set.
  const seen = new Set();
  const targets = (Array.isArray(recipients) ? recipients : []).filter((recipient) => {
    if (!recipient?.email) return false;
    const key = String(recipient._id || recipient.id || recipient.email);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (targets.length === 0) return [];

  // allSettled, not all: one unreachable address must not stop the other
  // recipients from being mailed, and each failure is logged against its own
  // address so a bad mailbox is identifiable from the logs.
  const results = await Promise.allSettled(
    targets.map(async (recipient) => {
      const data = {
        subject: `${studentName} completed ${assessmentTitle}`,
        preheader: `${studentName} has submitted ${assessmentTitle}. Review the submission and record a score.`,
        firstName: firstNameOf(recipient.fullname),
        studentName,
        assessmentTitle,
        assessmentType: typeLabel(assessment.type),
        questionCount: questionCount ? String(questionCount) : '',
        submittedAt,
        ctaUrl: providerAssessmentUrl(assessment, recipient),
        ctaLabel: 'View Score',
        brandHomeUrl,
        logoUrl,
        supportEmail,
        email: recipient.email,
      };

      const html = renderLayout('assessment-completed', data);
      const text = plainTextFallback([
        `Hi ${data.firstName},`,
        `${studentName} has completed the assessment: ${assessmentTitle}.`,
        `Type: ${data.assessmentType}`,
        questionCount ? `Questions: ${questionCount}` : null,
        `Submitted on: ${submittedAt}`,
        `Review the submission and view the score here: ${data.ctaUrl}`,
        'The Experthub Trainings Team',
      ]);

      return sendMail({
        to: recipient.email,
        subject: data.subject,
        html,
        text,
        replyTo: supportEmail,
      });
    }),
  );

  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      console.error(
        `Assessment completed email to ${targets[index].email} failed:`,
        result.reason?.message || result.reason,
      );
    }
  });

  return results;
}

module.exports = {
  sendAssessmentCompletedEmail,
  providerAssessmentUrl,
};
