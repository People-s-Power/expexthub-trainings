// Assessment assigned email.
//
// Emitted when a provider assigns an assessment to a student, so the student
// has a durable record of what was assigned, any instructions that came with
// it, and a direct link into the test. Sent from assignAssesment in
// controllers/accessmentController.js.
//
// The existing Notification document is still written alongside this email;
// nothing in the frontend renders that collection, which is why delivery is by
// mail rather than an in-app inbox.
const {
  sendMail,
  renderLayout,
  plainTextFallback,
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

/**
 * Human wording for the assessment's `type` field, which is stored as the
 * bare route value ('objective' / 'theory') the test page keys off.
 */
function typeLabel(type) {
  switch (String(type || '').toLowerCase()) {
    case 'objective':
      return 'Objective (multiple choice)';
    case 'theory':
      return 'Theory (written)';
    default:
      return type ? String(type) : 'Assessment';
  }
}

/**
 * The student-facing test page. This matches the exact route the assessment
 * card links to (/applicant/test/<id>?type=<type>), so the emailed button lands
 * on the working page rather than a redirect chain.
 */
function studentAssessmentUrl(assessment) {
  const id = assessment?._id || assessment?.id || '';
  const type = assessment?.type ? `?type=${encodeURIComponent(assessment.type)}` : '';
  return `${trainingUrl}/applicant/test/${id}${type}`;
}

/**
 * Sends the "you have been assigned an assessment" email.
 *
 * @param {Object} opts
 * @param {Object} opts.student    - { email, fullname }
 * @param {Object} opts.assessment - the Assessment document
 * @param {Object} [opts.tutor]    - the assigning user (fullname/organizationName)
 */
async function sendAssessmentAssignedEmail({ student, assessment, tutor }) {
  if (!student?.email || !assessment) {
    throw new Error('Assignment email needs a recipient and an assessment');
  }

  const assessmentTitle = assessment.title || 'Assessment';
  const questionCount = Array.isArray(assessment.assesment) ? assessment.assesment.length : 0;
  const tutorName = tutor?.organizationName || tutor?.fullname || 'Your training provider';
  // Trimmed so a stray blank string does not render an empty Instructions block.
  const instructions = String(assessment.instructions || '').trim();

  const data = {
    subject: `${assessmentTitle} — assessment assigned to you`,
    preheader: `${tutorName} assigned you ${assessmentTitle}.`,
    firstName: firstNameOf(student.fullname),
    emailHeading: 'New assessment',
    assessmentTitle,
    assessmentType: typeLabel(assessment.type),
    questionCount: questionCount ? String(questionCount) : '',
    tutorName,
    instructions,
    ctaUrl: studentAssessmentUrl(assessment),
    ctaLabel: 'Start assessment',
    brandHomeUrl,
    logoUrl,
    supportEmail,
    email: student.email,
  };

  const html = renderLayout('assessment-assigned', data);
  const text = plainTextFallback([
    `Hi ${data.firstName},`,
    `${tutorName} has assigned you an assessment: ${assessmentTitle}.`,
    `Type: ${data.assessmentType}`,
    questionCount ? `Questions: ${questionCount}` : null,
    instructions ? `Instructions: ${instructions}` : null,
    `Start the assessment here: ${data.ctaUrl}`,
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
  sendAssessmentAssignedEmail,
  studentAssessmentUrl,
  typeLabel,
  firstNameOf,
};
