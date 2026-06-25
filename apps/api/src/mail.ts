import { env } from "./env.js";

/**
 * Sends a transactional email. Uses SMTP (via nodemailer) when configured;
 * otherwise falls back to logging to the API console so development works
 * without an email provider.
 */
async function sendMail(to: string, subject: string, text: string, html: string, devLabel: string, devValue: string) {
  if (!env.SMTP_HOST) {
    console.log(`\n[Nexus] ${devLabel} for ${to}: ${devValue}\n`);
    return;
  }

  try {
    // Dynamic import keeps nodemailer optional and out of the type surface.
    const nodemailer = (await import("nodemailer")).default;
    const transport = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT ?? 587,
      secure: env.SMTP_SECURE,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined
    });

    await transport.sendMail({ from: env.SMTP_FROM, to, subject, text, html });
  } catch (error) {
    console.error("Failed to send email", error);
    console.log(`\n[Nexus] ${devLabel} for ${to}: ${devValue}\n`);
  }
}

export async function sendVerificationEmail(to: string, code: string) {
  await sendMail(
    to,
    "Your Nexus verification code",
    `Your Nexus verification code is ${code}. It expires in 10 minutes.`,
    codeHtml("Confirm your email to finish creating your account.", code),
    "Verification code",
    code
  );
}

export async function sendPasswordResetEmail(to: string, code: string) {
  await sendMail(
    to,
    "Reset your Nexus password",
    `Your Nexus password reset code is ${code}. It expires in 10 minutes. If you didn't request it, ignore this email.`,
    codeHtml("Use this code to reset your password.", code),
    "Password reset code",
    code
  );
}

function codeHtml(intro: string, code: string) {
  return `
  <div style="font-family:Inter,system-ui,sans-serif;max-width:440px;margin:auto;padding:32px;background:#1a1d21;border-radius:16px;color:#f2f4f0">
    <h1 style="margin:0 0 8px;color:#55d6a7">Nexus</h1>
    <p style="color:#9aa3ad;margin:0 0 24px">${intro}</p>
    <div style="font-size:34px;font-weight:800;letter-spacing:8px;text-align:center;padding:18px;background:#22262c;border-radius:12px">${code}</div>
    <p style="color:#9aa3ad;font-size:13px;margin-top:24px">This code expires in 10 minutes. If you didn't request it, ignore this email.</p>
  </div>`;
}
