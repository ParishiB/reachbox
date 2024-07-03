import nodemailer from "nodemailer";

export const sendEmail = async ({
  to,
  subject,
  text,
}: {
  to: any;
  subject: any;
  text: any;
}): Promise<void> => {
  console.log("The value of to is", to);
  console.log("The value of subject is", subject);
  console.log("The value of text is", text);

  if (!to) {
    throw new Error("No recipient defined.");
  }

  const smtpUser: any = process.env.SMTP_USER;
  const smtpPass: any = process.env.SMTP_PASS;

  let mailTransporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: smtpUser,
      pass: smtpPass,
    },
  });

  let mailDetails = {
    from: smtpUser,
    to,
    subject,
    text,
  };

  try {
    await mailTransporter.sendMail(mailDetails);
    console.log("Email sent successfully");
  } catch (err) {
    console.error("Error Occurs", err);
    throw err;
  }
};
