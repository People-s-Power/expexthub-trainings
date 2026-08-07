const crypto = require('crypto');

/**
 * Six-digit verification code.
 *
 * Uses the CSPRNG rather than Math.random: these codes gate email verification,
 * which in turn gates payment, so a predictable sequence would be a real
 * account-takeover path. randomInt is uniform over the range — no modulo bias.
 */
const generateVerificationCode = () => String(crypto.randomInt(100000, 1000000));

module.exports = {
  generateVerificationCode,
};
