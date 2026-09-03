// Shared SMTP transport and sender configuration for all transactional emails.
//
// Every transactional email (OTP verification, onboarding, payment receipt)
// goes through this one transporter so connection settings, sender identity,
// timeouts and environment configuration cannot drift between mailers.
//
// Expected environment variables:
//   SMTP_HOST                   - mail host (default mail.privateemail.com)
//   SMTP_PORT                   - port (default 465)
//   SMTP_SECURE                 - "true" for implicit TLS (default true)
//   MAIL_FROM                   - envelope From address (default VERIFICATION_EMAIL_USER)
//   VERIFICATION_EMAIL_USER     - SMTP username (default verify@experthubllc.com)
//   NOTIFICATION_EMAIL_PASSWORD - SMTP password
//
// Template rendering is shared here too. Templates are read from the repo's
// templates/emails directory using a path anchored to this file, so the
// process can be started from any working directory (dev, Procfile, Docker).
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const handlebars = require('handlebars');

const EMAIL_DIR = path.join(__dirname, 'templates');
const cache = {};

const smtpHost = process.env.SMTP_HOST || 'mail.privateemail.com';
const smtpPort = Number(process.env.SMTP_PORT || 465);
const smtpSecure = String(process.env.SMTP_SECURE || 'true').toLowerCase() === 'true';
const mailUser = process.env.VERIFICATION_EMAIL_USER || 'verify@experthubllc.com';
const mailFrom = process.env.MAIL_FROM || mailUser;

function transporter() {
  if (!process.env.NOTIFICATION_EMAIL_PASSWORD) {
    throw new Error('NOTIFICATION_EMAIL_PASSWORD is not configured');
  }
  return nodemailer.createTransport({
    host: smtpHost,
    port: smtpPort,
    secure: smtpSecure,
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 20000,
    auth: {
      user: mailUser,
      pass: process.env.NOTIFICATION_EMAIL_PASSWORD,
    },
  });
}

/**
 * Resolves a template name to its file path, regardless of cwd.
 * @param {string} name - e.g. 'otp'
 */
function templatePath(name) {
  return path.join(EMAIL_DIR, `${name}.html`);
}

// Register the shared shell as a partial so every body template can wrap itself
// in the same branded header/footer without repeating layout markup. The shell
// sits beside this module (not inside templates/), so it is read from here
// rather than through templatePath().
const LAYOUT_NAME = 'brand_layout';
if (!handlebars.partials[LAYOUT_NAME]) {
  // Compiled with default escaping: every `{{value}}` is HTML-escaped. The
  // pre-rendered body fragment is injected deliberately unescaped via the
  // triple-stash `{{{body}}}` in layout.html.
  handlebars.partials[LAYOUT_NAME] = handlebars.compile(
    fs.readFileSync(path.join(__dirname, 'layout.html'), 'utf8'),
  );
}

/**
 * Renders a body template inside the shared branded layout.
 *
 * `data` is passed to both the body and the layout. The body is expected to be
 * a fragment (no <html>/<head>), and is injected into the layout's `body`
 * placeholder.
 *
 * Common context keys:
 *   subject      - email subject (used for the <title> and preheader)
 *   preheader    - short preview text shown beside the subject in the inbox
 *   firstName    - recipient's first/given name
 *   logoUrl      - absolute logo image URL
 *   brandHomeUrl - main site URL
 *   supportEmail - support contact shown in the footer
 */
function renderLayout(name, data) {
  const context = {
    year: new Date().getFullYear(),
    ...data,
    body: renderTemplate(name, data),
  };
  return handlebars.partials[LAYOUT_NAME](context);
}

/**
 * Renders a handlebars template, using a per-name cache in production.
 * @param {string} name
 * @param {Object} data
 */
function renderTemplate(name, data) {
  const filePath = templatePath(name);
  if (cache[name] === undefined) {
    // Default escaping on: user-supplied values interpolated with {{ }} are
    // escaped. Only static HTML we authored (which never interpolates dynamic
    // data into attribute values that would need raw output) is in the files.
    cache[name] = handlebars.compile(fs.readFileSync(filePath, 'utf8'));
  }
  return cache[name](data || {});
}

/**
 * Sends a mail using the shared transporter.
 * @param {Object} opts { to, subject, html, text?, replyTo? }
 */
async function sendMail({ to, subject, html, text, replyTo }) {
  if (!to || !subject) throw new Error('Recipient and subject are required');
  if (!process.env.NOTIFICATION_EMAIL_PASSWORD) {
    throw new Error('NOTIFICATION_EMAIL_PASSWORD is not configured');
  }

  const mailOptions = {
    from: `"ExpertHub Trainings" <${mailFrom}>`,
    to,
    subject,
    html,
    ...(text ? { text } : {}),
    replyTo: replyTo || process.env.MAIL_REPLY_TO || mailFrom,
  };

  return transporter().sendMail(mailOptions);
}

/**
 * Plain-text fallback for any branded email, mirroring the key facts so the
 * message stays readable for recipients who disable HTML.
 */
function plainTextFallback(lines) {
  return (lines || []).filter(Boolean).join('\n\n');
}

/** Human-friendly currency formatting for NGN, e.g. ₦150,000. */
function formatNaira(amount) {
  const value = Number(amount);
  if (!Number.isFinite(value)) return '';
  const formatted = new Intl.NumberFormat('en-NG', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(value);
  return `₦${formatted}`;
}

/** Nice date rendering in a way email clients reliably display. */
function formatDate(date) {
  if (!date) return '';
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

module.exports = {
  transporter,
  sendMail,
  renderTemplate,
  renderLayout,
  templatePath,
  plainTextFallback,
  formatNaira,
  formatDate,
  EMAIL_DIR,
};
