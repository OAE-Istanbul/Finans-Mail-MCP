/**
 * Ortam degiskenleri. Sunucu acilirken bir kez okunur ve dogrulanir.
 * Eksik/hatali yapilandirmada surec basta patlar; calisirken sessizce yanlis
 * davranmaz.
 */

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `Zorunlu ortam degiskeni eksik: ${name}. .env.example dosyasina bakin.`,
    );
  }
  return value;
}

function optionalBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'evet';
}

function optionalInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} pozitif bir tam sayi olmali, alinan: ${raw}`);
  }
  return parsed;
}

function parseMailboxes(): string[] {
  const raw = process.env.MCP_MAILBOXES?.trim();
  if (!raw) {
    throw new Error(
      'MCP_MAILBOXES eksik. En az bir posta kutusu adresi verin, ornek: ' +
        'MCP_MAILBOXES="finans@rsresearch.net"',
    );
  }
  const list = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (list.length === 0) {
    throw new Error('MCP_MAILBOXES bos. En az bir adres gerekli.');
  }
  for (const address of list) {
    if (!address.includes('@')) {
      throw new Error(`MCP_MAILBOXES gecersiz adres iceriyor: ${address}`);
    }
  }
  return list;
}

const authToken = required('MCP_AUTH_TOKEN');
if (authToken.length < 24) {
  throw new Error(
    'MCP_AUTH_TOKEN en az 24 karakter olmali. Bu sunucu internete acik ' +
      'calisacagi icin tahmin edilebilir bir token kabul edilmiyor.',
  );
}

const mailboxes = parseMailboxes();
const allowSend = optionalBool('MCP_ALLOW_SEND', false);
const sendMailboxRaw = process.env.MCP_SEND_MAILBOX?.trim();

if (allowSend && !sendMailboxRaw) {
  throw new Error(
    'MCP_ALLOW_SEND acik ama MCP_SEND_MAILBOX tanimli degil. Gonderimin hangi ' +
      'kutudan yapilacagini acikca belirtin.',
  );
}

export const config = {
  tenantId: required('AZURE_TENANT_ID'),
  clientId: required('AZURE_CLIENT_ID'),
  clientSecret: required('AZURE_CLIENT_SECRET'),

  /** Erisime izin verilen posta kutulari. Ilk sirada olan varsayilan. */
  mailboxes,
  defaultMailbox: mailboxes[0]!,

  /** Istemci tarafindan gonderilmesi gereken Bearer token. */
  authToken,

  /** Tarih araligi verilmedigi zaman geriye dogru bakilacak gun sayisi. */
  lookbackDays: optionalInt('MCP_LOOKBACK_DAYS', 730),

  /** Tek istekte donebilecek en fazla mesaj sayisi. */
  maxPageSize: optionalInt('MCP_MAX_PAGE_SIZE', 100),

  /** Ek indirmede izin verilen en buyuk dosya boyutu (bayt). */
  maxAttachmentBytes: optionalInt('MCP_MAX_ATTACHMENT_BYTES', 4_000_000),

  /** Yazma araclari (mail gonderme) acik mi. Varsayilan kapali. */
  allowSend,
  sendMailbox: sendMailboxRaw ?? null,

  port: optionalInt('PORT', 5000),
} as const;

export type AppConfig = typeof config;
