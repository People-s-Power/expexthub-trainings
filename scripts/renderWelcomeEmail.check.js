// Smoke-render the welcome template in both its provider-credentials variant and
// the existing self-signup variants, so a Handlebars block mismatch shows up here
// rather than in a live send.
process.env.TRAINING_URL = process.env.TRAINING_URL || 'https://trainings.experthubllc.com';
const { renderLayout } = require('../utils/emails/mailer.js');

const base = {
  firstName: 'Ada',
  email: 'ada@example.com',
  brandHomeUrl: 'https://experthubllc.com',
  logoUrl: 'https://trainings.experthubllc.com/images/logo.png',
  supportEmail: 'support@experthubllc.com',
  expiryMinutes: 15,
  loginUrl: 'https://trainings.experthubllc.com/auth/login',
  changePasswordUrl: 'https://trainings.experthubllc.com/applicant/profile#password',
};

const cases = [
  ['credentials', { ...base, heading: 'Your account is ready', ctaUrl: base.changePasswordUrl, ctaLabel: 'Change your password', credentials: { email: 'ada@example.com', password: 'Kq7-Rm2-Tv9' }, registeredByName: 'Bright Futures Academy' }],
  ['credentials-no-provider', { ...base, heading: 'Your account is ready', ctaUrl: base.changePasswordUrl, ctaLabel: 'Change your password', credentials: { email: 'ada@example.com', password: 'Kq7-Rm2-Tv9' } }],
  ['activationPending', { ...base, heading: 'Welcome to Experthub!', activationPending: true, ctaUrl: base.loginUrl, ctaLabel: 'Go to my dashboard' }],
  ['student-ready', { ...base, heading: 'Welcome to Experthub!', ctaUrl: 'https://trainings.experthubllc.com/courses', ctaLabel: 'Explore courses' }],
  ['tutor-ready', { ...base, heading: 'Welcome, Trainer!', isTutor: true, ctaUrl: 'https://trainings.experthubllc.com/tutor/profile', ctaLabel: 'Complete your profile' }],
];

let failed = 0;
for (const [name, data] of cases) {
  try {
    const html = renderLayout('welcome', data);
    const checks = [];
    if (name.startsWith('credentials')) {
      if (!html.includes('Kq7-Rm2-Tv9')) checks.push('missing password');
      if (!html.includes(base.changePasswordUrl)) checks.push('missing change-password link');
      if (html.includes('verify your email')) checks.push('leaked activation copy');
      if (html.includes('EXPLORE COURSES')) checks.push('leaked student steps');
    } else {
      if (html.includes('YOUR SIGN-IN DETAILS')) checks.push('leaked credentials block');
    }
    if (html.includes('{{')) checks.push('unrendered handlebars token');
    if (checks.length) {
      failed += 1;
      console.log(`FAIL ${name}: ${checks.join(', ')}`);
    } else {
      console.log(`ok   ${name} (${html.length} bytes)`);
    }
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${name}: ${error.message}`);
  }
}
process.exit(failed ? 1 : 0);
