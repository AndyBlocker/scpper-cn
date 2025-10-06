import nodemailer from 'nodemailer';

export function createMailer(config) {
  const transporter = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: {
      user: config.smtp.user,
      pass: config.smtp.pass
    }
  });

  function buildFromHeader() {
    const { fromName, fromAddress } = config.smtp;
    return fromName ? `${fromName} <${fromAddress}>` : fromAddress;
  }

  async function send({ to, subject, text, html, headers, replyTo }) {
    const info = await transporter.sendMail({
      from: buildFromHeader(),
      to,
      subject,
      text,
      html,
      replyTo: replyTo || config.defaults.replyTo,
      headers: {
        'Auto-Submitted': 'auto-generated',
        'X-Auto-Response-Suppress': 'All',
        ...headers
      }
    });
    return info;
  }

  return { send };
}
