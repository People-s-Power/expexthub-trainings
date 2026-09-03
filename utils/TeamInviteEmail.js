const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: 'mail.privateemail.com',
  port: 465,
  auth: {
    user: 'trainings@experthubllc.com',
    pass: process.env.NOTIFICATION_EMAIL_PASSWORD,
  },
});


const sendTeamInvitation = async (to, senderName, tutorId, ownerId, tutorName, memberRole = "team member") => {

  const acceptLink = `https://trainings.experthubllc.com/tutor/team/user?tutorId=${tutorId}&ownerId=${ownerId}&status=accepted`;
  const rejectLink = `https://trainings.experthubllc.com/tutor/team/user?tutorId=${tutorId}&ownerId=${ownerId}&status=rejected`;

  // Present the member's category (tutor, client, student, provider, admin)
  // in a human friendly form: "Team member" -> "Team Member".
  const roleLabel = (memberRole || "team member")
    .replace(/_/g, " ")
    .split(" ")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");

  const htmlMessage = `
    <div style="font-family: Arial, sans-serif; padding: 20px; background-color: #f4f4f4;">
      <div style="max-width: 600px; margin: auto; background: #ffffff; padding: 20px; border-radius: 8px; box-shadow: 0 0 10px rgba(0, 0, 0, 0.1);">
        <h2 style="color: #333;">You're Invited to Join <span style="color: #007bff;">${senderName}</span>!</h2>
        <p>Hello, ${tutorName}</p>
        <p><strong>${senderName}</strong> has invited you to join their team as a <strong>${roleLabel}</strong>.</p>
        <p>Please click below to accept or decline the invitation:</p>
        <div style="margin: 20px 0;">
          <a href="${acceptLink}">
          <button
              style="border: none; background-color: #28a745; color: white; padding: 10px; border-radius: 10px; margin-bottom: 10px; width: 100%;">
              ✅ Accept Invitation
            </button>
          </a>
          
          <a href="${rejectLink}">
              <button style="border: none; background-color: #dc3545; color: white; padding: 10px; border-radius: 10px; margin-bottom: 10px; width: 100%;">
              ❌ Reject Invitation
            </button>
          </a>
         
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