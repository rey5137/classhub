import type { Mailer, MailMessage } from '../../ports/mailer';

/** Tests and the offline dev build: keeps every message instead of sending it. */
export function createRecordingMailer(options: { fail?: boolean } = {}) {
  const sent: MailMessage[] = [];
  const mailer: Mailer = {
    async send(message) {
      if (options.fail) throw new Error('mail rejected');
      sent.push(message);
    },
  };
  return { mailer, sent };
}
