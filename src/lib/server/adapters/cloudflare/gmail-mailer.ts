import type { Mailer, MailMessage } from '../../ports/mailer';

// R-AUTH-31: the owner's Gmail over SMTP (implicit TLS, port 465) with an app password,
// through Workers TCP sockets. `worker-mailer` imports `cloudflare:sockets`, which Node
// (vite dev) cannot load, so it is imported only when a message is sent.

export interface GmailCredentials {
  user: string;
  appPassword: string;
}

export function createGmailMailer(credentials: GmailCredentials): Mailer {
  return {
    async send(message: MailMessage) {
      const { WorkerMailer } = await import('worker-mailer');
      const mailer = await WorkerMailer.connect({
        credentials: { username: credentials.user, password: credentials.appPassword },
        authType: 'plain',
        host: 'smtp.gmail.com',
        port: 465,
        secure: true,
      });
      try {
        await mailer.send({
          from: { name: message.fromName, email: credentials.user },
          to: { email: message.to },
          subject: message.subject,
          text: message.text,
        });
      } finally {
        await mailer.close().catch(() => undefined);
      }
    },
  };
}
