import { env } from "./env.js";

/**
 * Sends a verification email. Uses SMTP (via nodemailer) when configured;
 * otherwise falls back to logging the code to the API console so development
 * works without an email provider.
 */
export async function sendVerificationEmail(to: string, code: string) {
  if (!env.SMTP_HOST) {
    console.log(`\n[Nexus] Verification code for ${to}: ${code}\n`);
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

    await transport.sendMail({
      from: env.SMTP_FROM,
      to,
      subject: "Your Nexus verification code",
      text: `Your Nexus verification code is ${code}. It expires in 10 minutes.`,
      html: verificationHtml(code)
    });
  } catch (error) {
    console.error("Failed to send verification email", error);
    console.log(`\n[Nexus] Verification code for ${to}: ${code}\n`);
  }
}

function verificationHtml(code: string) {
  return `
  <div style="font-family:Inter,system-ui,sans-serif;max-width:440px;margin:auto;padding:32px;background:#1a1d21;border-radius:16px;color:#f2f4f0">
    <h1 style="margin:0 0 8px;color:#55d6a7">Nexus</h1>
    <p style="color:#9aa3ad;margin:0 0 24px">Confirm your email to finish creating your account.</p>
    <div style="font-size:34px;font-weight:800;letter-spacing:8px;text-align:center;padding:18px;background:#22262c;border-radius:12px">${code}</div>
    <p style="color:#9aa3ad;font-size:13px;margin-top:24px">This code expires in 10 minutes. If you didn't request it, ignore this email.</p>
  </div>`;
}
