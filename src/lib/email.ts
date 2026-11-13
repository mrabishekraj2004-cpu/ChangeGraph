export type EmailDelivery = {
  sent: boolean;
  configured: boolean;
  error?: string;
};

type EmailInput = {
  to: string;
  subject: string;
  text: string;
  html: string;
};

export async function sendTransactionalEmail(input: EmailInput): Promise<EmailDelivery> {
  const provider = process.env.EMAIL_PROVIDER?.trim().toLowerCase();
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.EMAIL_FROM?.trim();
  if (provider !== "resend" || !apiKey || !from) return { sent: false, configured: false };

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [input.to], subject: input.subject, text: input.text, html: input.html }),
      cache: "no-store",
    });
    if (!response.ok) return { sent: false, configured: true, error: `Email provider returned ${response.status}.` };
    return { sent: true, configured: true };
  } catch {
    return { sent: false, configured: true, error: "Email provider could not be reached." };
  }
}
