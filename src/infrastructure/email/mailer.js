'use strict';

const config = require('../../config');
const logger = require('../../core/logger');

/**
 * Outbound email.
 *
 * Two transports exist. `console` writes the message to the log instead of
 * sending it, which is what lets the forgot password flow be exercised with no
 * SMTP server configured. `smtp` performs a real send and is the default when
 * PROD is enabled.
 *
 * nodemailer is loaded lazily so a deployment that never sends mail does not
 * pay for the dependency at boot.
 */

let transporter = null;

/**
 * Builds the SMTP transport on first use.
 *
 * @returns {object} A nodemailer transporter.
 * @throws {Error} When SMTP settings are incomplete.
 */
function getSmtpTransport() {
  if (transporter !== null) return transporter;

  if (!config.mail.smtpHost) {
    throw new Error('MAIL_TRANSPORT is "smtp" but SMTP_HOST is not configured.');
  }

  // eslint-disable-next-line global-require
  const nodemailer = require('nodemailer');
  transporter = nodemailer.createTransport({
    host: config.mail.smtpHost,
    port: config.mail.smtpPort,
    secure: config.mail.smtpSecure,
    auth: config.mail.smtpUser
      ? { user: config.mail.smtpUser, pass: config.mail.smtpPassword }
      : undefined,
  });

  return transporter;
}

/**
 * Rejects header injection in an address or subject.
 *
 * A newline in either field lets an attacker append arbitrary SMTP headers,
 * so anything carrying one is refused rather than trimmed.
 *
 * @param {string} value Candidate value.
 * @param {string} field Field name, used in the error.
 * @returns {string} The value, unchanged.
 * @throws {Error} When the value contains a line break.
 */
function assertNoHeaderInjection(value, field) {
  if (/[\r\n]/.test(String(value))) {
    throw new Error(`The email ${field} must not contain a line break.`);
  }
  return value;
}

/**
 * Sends one message.
 *
 * @param {object} message Message to send.
 * @param {string} message.to Recipient address.
 * @param {string} message.subject Subject line.
 * @param {string} message.text Plain text body.
 * @returns {Promise<{delivered: boolean, transport: string}>}
 */
async function sendMail({ to, subject, text }) {
  assertNoHeaderInjection(to, 'recipient');
  assertNoHeaderInjection(subject, 'subject');

  if (config.mail.transport === 'console') {
    // The body can contain a single use token, so it is logged at debug level
    // only and never at info, where it would reach a shipped log by default.
    logger.debug('Outbound email (console transport).', { to, subject, text });
    return { delivered: true, transport: 'console' };
  }

  await getSmtpTransport().sendMail({ from: config.mail.from, to, subject, text });
  logger.info('Email sent.', { to, subject });
  return { delivered: true, transport: 'smtp' };
}

/**
 * Sends a password reset message.
 *
 * @param {object} params Message parameters.
 * @param {string} params.to Recipient address.
 * @param {string} params.userId Recipient's routing identifier.
 * @param {string} params.token Single use reset token.
 * @param {number} params.expiresInSeconds Token lifetime.
 * @returns {Promise<object>} Delivery outcome.
 */
async function sendPasswordResetEmail({ to, userId, token, expiresInSeconds }) {
  const minutes = Math.round(expiresInSeconds / 60);
  const link = `${config.app.clientUrl}/reset-password?token=${encodeURIComponent(token)}`;

  return sendMail({
    to,
    subject: 'Reset your LXTranslator password',
    text: [
      `Hello ${userId},`,
      '',
      'A password reset was requested for your LXTranslator account.',
      `Open the link below to choose a new password. It expires in ${minutes} minutes`,
      'and stops working the moment it is used once.',
      '',
      link,
      '',
      'If you did not request this, no action is needed and your password is unchanged.',
    ].join('\n'),
  });
}

module.exports = { sendMail, sendPasswordResetEmail, assertNoHeaderInjection };
