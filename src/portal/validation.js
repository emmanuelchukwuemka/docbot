// Input validation/normalization for the web self-service portal (register/login).

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(email) {
  return EMAIL_RE.test(String(email || "").trim());
}

export function isValidPassword(password) {
  return typeof password === "string" && password.length >= 8;
}

/** Strips everything but digits. Deliberately does NOT try to add/replace a country's trunk
 * prefix (e.g. Nigeria's leading "0") — that's genuinely ambiguous across ~195 countries
 * without knowing which one the user is dialing from, so the register form instead asks for
 * the number in full international format to begin with. */
export function normalizePhoneDigits(raw) {
  return String(raw || "").replace(/\D/g, "");
}

/** Matches how whatsapp/baileysClient.js's toJid() defaults an undecorated number — the
 * `users.whatsapp_number` column always stores the full JID form (`<digits>@s.whatsapp.net`),
 * never bare digits, because that's the exact string real inbound WhatsApp messages arrive
 * keyed on (see whatsapp/ingest.js's getOrCreateUser). A web registration has to land on the
 * identical string, or it creates a second, disconnected identity instead of merging with
 * whatever the bot already knows about this person. */
export function phoneToWhatsappNumber(rawPhone) {
  const digits = normalizePhoneDigits(rawPhone);
  return digits ? `${digits}@s.whatsapp.net` : "";
}

/** Combines the register form's separate country-code dropdown + local-number field into one
 * dialable number. Done server-side (not left to client JS) so it's the actual guarantee, not
 * just a nicety — a form POST can always skip the browser. Strips a single leading trunk "0"
 * off the local number when a dial code is given (Nigeria 08012345678 -> 2348012345678, and
 * the same convention holds across most — not all — countries with a "0" trunk prefix); if no
 * dial code was picked ("Other"), the local-number field is trusted as-is, already-international
 * digits. */
export function combinePhoneNumber(dialCode, localNumber) {
  const dial = normalizePhoneDigits(dialCode);
  let local = normalizePhoneDigits(localNumber);
  if (dial && local.startsWith("0")) local = local.slice(1);
  return phoneToWhatsappNumber(dial + local);
}
