// R-AUTH-31: outgoing email. Today one message kind: the invite email an admin sends
// once the address is in the Access policy. Plain text only; the adapter picks the sender.

export interface MailMessage {
  /** The sender's display name (the class site's name); the address is the adapter's. */
  fromName: string;
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  /** Resolves once the server accepted the message; throws on any failure. */
  send(message: MailMessage): Promise<void>;
}
