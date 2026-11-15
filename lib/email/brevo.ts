/**
 * 邮箱发送（Brevo / Sendinblue HTTP API）
 *
 * 为什么选 Brevo：Workers 环境没有原始 TCP（发不了 SMTP），只能走 HTTP API；
 * Brevo 免费档每天 300 封，且「发件人」只需邮箱确认、不要求自有域名，
 * 与本站（pages.dev 域名、无备案）的现状匹配。Resend 不验证域名时只能发给自己。
 *
 * 配置（全部为服务端变量 / 密钥，不进客户端包）：
 *   BREVO_API_KEY  Brevo 控制台 SMTP & API → API Keys 生成的 key
 *   EMAIL_FROM     已在 Brevo 验证过的发件邮箱
 *   EMAIL_FROM_NAME 发件人显示名（可选，默认「紫微命盘」）
 *
 * 未配置时 sendEmail 返回 { ok:false, code:'EMAIL_NOT_CONFIGURED' }，由调用方给出明确提示。
 * 免费档 300 封/天 为公开规则，限额与政策可能变化，需以 Brevo 控制台为准。
 */

export interface EmailConfig {
  apiKey: string;
  fromEmail: string;
  fromName: string;
}

export function emailConfig(): EmailConfig | null {
  const apiKey = process.env.BREVO_API_KEY;
  const fromEmail = process.env.EMAIL_FROM;
  if (!apiKey || !fromEmail) return null;
  return { apiKey, fromEmail, fromName: process.env.EMAIL_FROM_NAME || '紫微命盘' };
}

export type SendEmailResult =
  | { ok: true }
  | { ok: false; code: 'EMAIL_NOT_CONFIGURED' | 'SEND_FAILED'; message: string };

export async function sendEmail(to: string, subject: string, text: string): Promise<SendEmailResult> {
  const config = emailConfig();
  if (!config) {
    return { ok: false, code: 'EMAIL_NOT_CONFIGURED', message: '邮件服务未配置，请联系维护者' };
  }
  try {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'accept': 'application/json',
        'content-type': 'application/json',
        'api-key': config.apiKey,
      },
      body: JSON.stringify({
        sender: { email: config.fromEmail, name: config.fromName },
        to: [{ email: to }],
        subject,
        textContent: text,
      }),
    });
    if (!res.ok) {
      // 4xx/5xx：不把上游报文原样透给用户，避免泄露账号信息
      return { ok: false, code: 'SEND_FAILED', message: '邮件发送失败，请稍后重试' };
    }
    return { ok: true };
  } catch {
    return { ok: false, code: 'SEND_FAILED', message: '邮件发送失败，请稍后重试' };
  }
}
