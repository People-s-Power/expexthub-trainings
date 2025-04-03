const nodemailer = require('nodemailer');
const invitations = {}; // Temporary store for invitation tokens

const transporter = nodemailer.createTransport({
  host: 'mail.privateemail.com',
  port: 465,
  auth: {
    user: 'trainings@experthubllc.com',
    pass: process.env.NOTIFICATION_EMAIL_PASSWORD,
  },
});


const sendTeamInvitation = async (to, senderName, tutorId, ownerId, tutorName) => {
  const token = Math.random().toString(36).substr(2, 10);
  invitations[token] = { tutorId, ownerId };

  const acceptLink = `https://seashell-app-nejbh.ondigitalocean.app/user/team/${tutorId}/${ownerId}/accepted`;
  const rejectLink = `https://seashell-app-nejbh.ondigitalocean.app/user/team/${tutorId}/${ownerId}/rejected`;

  const htmlMessage = `
    <div style="font-family: Arial, sans-serif; padding: 20px; background-color: #f4f4f4;">
      <div style="max-width: 600px; margin: auto; background: #ffffff; padding: 20px; border-radius: 8px; box-shadow: 0 0 10px rgba(0, 0, 0, 0.1);">
        <h2 style="color: #333;">You're Invited to Join <span style="color: #007bff;">${senderName}</span>!</h2>
        <p>Hello, ${tutorName}</p>
        <p><strong>${senderName}</strong> has invited you to join the team.</p>
        <p>Please click below to accept or decline the invitation:</p>
        <div style="margin: 20px 0;">
          <a href="${acceptLink}" style="background: #28a745; color: #ffffff; width: 100%; padding: 12px 20px; text-decoration: none; border-radius: 5px; font-size: 16px; margin-right: 10px;">✅ Accept Invitation</a> <br /> <br/br>
          <a href="${rejectLink}" style="background: #dc3545; color: #ffffff; width: 100%; padding: 12px 20px; text-decoration: none; border-radius: 5px; font-size: 16px;">❌ Reject Invitation</a>
        </div>
        <p>Best regards,</p>
        <p><strong>The ExpertHub Team</strong></p>
      </div>
    </div>
  `;

  const mailOptions = {
    from: 'trainings@experthubllc.com',
    to,
    subject: `Team Invitation`,
    html: htmlMessage,
  };

  return transporter.sendMail(mailOptions);
};

module.exports = {
  sendTeamInvitation,
}