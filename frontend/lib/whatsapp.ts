// WhatsApp click-to-chat links (https://wa.me/...). They need no WhatsApp account set up here:
// the link opens WhatsApp on the person's phone or computer with the message typed in, ready to send.

// The number as WhatsApp wants it: digits only, with the country code and no + or leading 00.
// A number written the local way (starting with a single 0, like 07700 900123) has no country code,
// so none is used and WhatsApp asks who to send to.
export const whatsappNumber = (phone: string | null | undefined): string => {
  const written = String(phone || '').trim();
  let digits = written.replace(/\D/g, '');
  if (!digits) return '';
  if (written.startsWith('+')) return digits.length >= 7 ? digits : '';
  if (digits.startsWith('00')) digits = digits.slice(2);
  else if (digits.startsWith('0')) return '';
  return digits.length >= 7 && digits.length <= 15 ? digits : '';
};

// https://wa.me/<digits>?text=<message>, or https://wa.me/?text=<message> when there is no usable number
export const whatsappLink = (phone?: string | null, text?: string): string => {
  const number = whatsappNumber(phone);
  const message = (text || '').trim();
  return `https://wa.me/${number}${message ? `?text=${encodeURIComponent(message)}` : ''}`;
};

const firstName = (name?: string | null) => String(name || '').trim().split(/\s+/)[0] || '';

// A booking reminder with the time and the customer's own reschedule/cancel link
export const bookingReminderText = ({ name, service, staff, when, link }: {
  name?: string | null; service?: string | null; staff?: string | null; when: string; link?: string | null;
}) => [
  `Hi${firstName(name) ? ` ${firstName(name)}` : ''}, this is a reminder of your ${service || 'booking'}${staff ? ` with ${staff}` : ''} on ${when}.`,
  link ? `If you need to reschedule or cancel, you can do it here: ${link}` : ''
].filter(Boolean).join('\n\n');

// For the invoice pages (owned by Accounting): a WhatsApp message with the invoice and its pay link.
//   <a className="button" href={invoiceWhatsAppLink(customer.phone, { number, total, due, link })}
//      target="_blank" rel="noopener noreferrer">Send on WhatsApp</a>
export const invoiceWhatsAppText = ({ name, number, total, due, link, company }: {
  name?: string | null; number?: string | null; total?: string | null; due?: string | null; link?: string | null; company?: string | null;
}) => [
  `Hi${firstName(name) ? ` ${firstName(name)}` : ''}, here is invoice ${number || ''}${company ? ` from ${company}` : ''}`.trim()
    + `${total ? ` for ${total}` : ''}${due ? `, due ${due}` : ''}.`,
  link ? `You can view and pay it here: ${link}` : '',
  'Thank you!'
].filter(Boolean).join('\n\n');

export const invoiceWhatsAppLink = (phone: string | null | undefined, invoice: Parameters<typeof invoiceWhatsAppText>[0]) =>
  whatsappLink(phone, invoiceWhatsAppText(invoice));
