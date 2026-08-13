/**
 * Posta kutusu okuma/arama mantigi.
 *
 * Graph'in en can sikici kisitlarini burada tek yerde ele aliyoruz:
 *  - `$search` ile `$filter` ve `$orderby` AYNI istekte kullanilamaz.
 *  - Metin aramasi gerektiginde her sey KQL'e cevrilir (tarih dahil), aksi
 *    halde OData `$filter` kullanilir ve sonuclar tarihe gore siralanir.
 */
import { config } from './config.js';
import { graphFetch, graphPathFromNextLink } from './graph.js';

const SELECT_FIELDS = [
  'id',
  'subject',
  'from',
  'toRecipients',
  'ccRecipients',
  'receivedDateTime',
  'sentDateTime',
  'hasAttachments',
  'bodyPreview',
  'webLink',
  'conversationId',
].join(',');

/** Graph'in isimle kabul ettigi standart klasorler. */
const WELL_KNOWN_FOLDERS = new Set([
  'inbox',
  'sentitems',
  'drafts',
  'deleteditems',
  'archive',
  'junkemail',
  'outbox',
  'clutter',
  'conflicts',
  'conversationhistory',
  'localfailures',
  'msgfolderroot',
  'recoverableitemsdeletions',
  'scheduled',
  'searchfolders',
  'serverfailures',
  'syncissues',
]);

export interface MessageSummary {
  id: string;
  subject: string;
  fromName: string;
  fromAddress: string;
  to: string[];
  cc: string[];
  receivedDateTime: string | null;
  sentDateTime: string | null;
  hasAttachments: boolean;
  preview: string;
  conversationId: string | null;
  webLink: string | null;
}

interface GraphRecipient {
  emailAddress?: { name?: string; address?: string };
}

interface GraphMessage {
  id: string;
  subject?: string;
  from?: GraphRecipient;
  toRecipients?: GraphRecipient[];
  ccRecipients?: GraphRecipient[];
  receivedDateTime?: string;
  sentDateTime?: string;
  hasAttachments?: boolean;
  bodyPreview?: string;
  conversationId?: string;
  webLink?: string;
  body?: { contentType?: string; content?: string };
}

function addressesOf(list: GraphRecipient[] | undefined): string[] {
  return (list ?? [])
    .map((entry) => entry.emailAddress?.address)
    .filter((value): value is string => Boolean(value));
}

function toSummary(message: GraphMessage): MessageSummary {
  return {
    id: message.id,
    subject: message.subject ?? '(konu yok)',
    fromName: message.from?.emailAddress?.name ?? '',
    fromAddress: message.from?.emailAddress?.address ?? '',
    to: addressesOf(message.toRecipients),
    cc: addressesOf(message.ccRecipients),
    receivedDateTime: message.receivedDateTime ?? null,
    sentDateTime: message.sentDateTime ?? null,
    hasAttachments: Boolean(message.hasAttachments),
    preview: (message.bodyPreview ?? '').trim(),
    conversationId: message.conversationId ?? null,
    webLink: message.webLink ?? null,
  };
}

/** OData string literali icin tek tirnaklari kacir. */
function odataLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * KQL degerini temizler.
 *
 * Tum KQL ifadesi disaridan `$search="..."` seklinde cift tirnakla sarildigi
 * icin deger ICINDE cift tirnak KULLANILAMAZ — Graph ic ice tirnagi
 * ayristiramayip "An identifier was expected at position 0" hatasi verir.
 * Graph'in kendi ornekleri de degerleri tirnaksiz yazar (`subject:Let's go`),
 * bu yuzden tirnaklari tamamen atiyoruz.
 */
function kqlValue(value: string): string {
  return value
    .replace(/[\r\n]+/g, ' ')
    .replace(/["()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * `from:`, `to:`, `subject:` gibi alan degerleri icin ek temizlik.
 *
 * Cift tirnaga ek olarak iki nokta ustuste ve KQL mantik operatorleri de
 * ayiklanir; aksi halde `subject` alanina `x OR from:ceo@sirket.com` yazilarak
 * cagirinin istedigi kisitlar gecersizlestirilebilir. Bu bir yetki asimi degil
 * (kutu sinirini `resolveMailbox` koruyor) ama sonuclari sessizce yanlislar.
 */
function kqlFieldValue(value: string): string {
  return kqlValue(value)
    .replace(/[:]/g, ' ')
    .replace(/\b(AND|OR|NOT|NEAR|ONEAR)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseDate(value: string | undefined, label: string): Date | null {
  if (!value || !value.trim()) return null;
  const parsed = new Date(value.trim());
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(
      `${label} gecerli bir tarih degil: '${value}'. ISO 8601 kullanin, ornek: 2024-01-31 veya 2024-01-31T00:00:00Z`,
    );
  }
  return parsed;
}

function ymd(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export interface FolderInfo {
  id: string;
  displayName: string;
  totalItemCount: number;
  unreadItemCount: number;
  parent: string | null;
}

/** Klasorleri iki seviye derinlige kadar listeler. */
export async function listFolders(mailbox: string): Promise<FolderInfo[]> {
  interface GraphFolder {
    id: string;
    displayName?: string;
    totalItemCount?: number;
    unreadItemCount?: number;
    childFolderCount?: number;
  }

  const top = await graphFetch<{ value?: GraphFolder[] }>(
    `/users/${encodeURIComponent(mailbox)}/mailFolders?$top=100&$select=id,displayName,totalItemCount,unreadItemCount,childFolderCount`,
  );

  const result: FolderInfo[] = [];
  const parents = top.value ?? [];

  for (const folder of parents) {
    result.push({
      id: folder.id,
      displayName: folder.displayName ?? '(isimsiz)',
      totalItemCount: folder.totalItemCount ?? 0,
      unreadItemCount: folder.unreadItemCount ?? 0,
      parent: null,
    });
  }

  const withChildren = parents.filter((f) => (f.childFolderCount ?? 0) > 0);
  const childResponses = await Promise.all(
    withChildren.map((folder) =>
      graphFetch<{ value?: GraphFolder[] }>(
        `/users/${encodeURIComponent(mailbox)}/mailFolders/${folder.id}/childFolders?$top=100&$select=id,displayName,totalItemCount,unreadItemCount`,
      ).catch(() => ({ value: [] as GraphFolder[] })),
    ),
  );

  childResponses.forEach((response, index) => {
    const parent = withChildren[index]!;
    for (const child of response.value ?? []) {
      result.push({
        id: child.id,
        displayName: child.displayName ?? '(isimsiz)',
        totalItemCount: child.totalItemCount ?? 0,
        unreadItemCount: child.unreadItemCount ?? 0,
        parent: parent.displayName ?? null,
      });
    }
  });

  return result;
}

async function resolveFolderSegment(
  mailbox: string,
  folder: string,
): Promise<string> {
  const normalized = folder.trim();
  const lower = normalized.toLowerCase();

  if (WELL_KNOWN_FOLDERS.has(lower)) {
    return lower;
  }

  // Graph klasor kimlikleri uzun, base64url-benzeri dizelerdir. Yalnizca bu dar
  // karakter kumesini kabul ediyoruz; "uzun ve bosluksuz" gibi gevsek bir
  // sezgiyle gecirmek, icinde '/' bulunan bir degerin URL'de baska bir
  // /users/<kutu>/ yoluna sapmasina izin verirdi.
  if (normalized.length > 40 && /^[A-Za-z0-9_\-=+]+$/.test(normalized)) {
    return normalized;
  }

  const response = await graphFetch<{ value?: { id: string }[] }>(
    `/users/${encodeURIComponent(mailbox)}/mailFolders?$filter=${encodeURIComponent(
      `displayName eq '${odataLiteral(normalized)}'`,
    )}&$select=id&$top=1`,
  );
  const found = response.value?.[0];
  if (found) return found.id;

  throw new Error(
    `'${folder}' adli klasor ust seviyede bulunamadi. Once list_folders aracini ` +
      `calistirip donen 'id' degerini kullanin. Standart isimler dogrudan ` +
      `gecerlidir: ${[...WELL_KNOWN_FOLDERS].slice(0, 6).join(', ')}.`,
  );
}

export interface SearchOptions {
  mailbox: string;
  folder?: string | undefined;
  query?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  subject?: string | undefined;
  since?: string | undefined;
  until?: string | undefined;
  hasAttachments?: boolean | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
}

export interface SearchResult {
  mailbox: string;
  folder: string;
  mode: 'search' | 'filter';
  windowStart: string;
  windowEnd: string | null;
  count: number;
  messages: MessageSummary[];
  nextCursor: string | null;
  notes: string[];
}

export async function searchMessages(
  options: SearchOptions,
): Promise<SearchResult> {
  const limit = Math.min(
    Math.max(options.limit ?? 25, 1),
    config.maxPageSize,
  );

  const folderLabel = options.folder?.trim() || 'tum kutu';
  const isSentFolder = (options.folder ?? '').trim().toLowerCase() === 'sentitems';
  const odataDateField = isSentFolder ? 'sentDateTime' : 'receivedDateTime';
  const kqlDateField = isSentFolder ? 'sent' : 'received';

  const until = parseDate(options.until, 'until');
  const since =
    parseDate(options.since, 'since') ??
    new Date(Date.now() - config.lookbackDays * 24 * 60 * 60 * 1000);

  if (until && until < since) {
    throw new Error("'until' tarihi 'since' tarihinden once olamaz.");
  }

  const notes: string[] = [];

  // Devam sayfasi istendiyse imleci once dogrula: istemciden geri geldigi icin
  // guvenilmez sayilir ve baska bir kutuya ya da Graph disi bir adrese
  // yonlendirmemesi gerekir.
  if (options.cursor) {
    const page = await graphFetch<{
      value?: GraphMessage[];
      '@odata.nextLink'?: string;
    }>(graphPathFromNextLink(options.cursor, options.mailbox));

    return {
      mailbox: options.mailbox,
      folder: folderLabel,
      mode: 'filter',
      windowStart: since.toISOString(),
      windowEnd: until ? until.toISOString() : null,
      count: page.value?.length ?? 0,
      messages: (page.value ?? []).map(toSummary),
      nextCursor: page['@odata.nextLink'] ?? null,
      notes: ['Bu sonuc onceki aramanin devam sayfasidir.'],
    };
  }

  const basePath = options.folder
    ? `/users/${encodeURIComponent(options.mailbox)}/mailFolders/${encodeURIComponent(
        await resolveFolderSegment(options.mailbox, options.folder),
      )}/messages`
    : `/users/${encodeURIComponent(options.mailbox)}/messages`;

  const needsTextSearch = Boolean(
    options.query?.trim() || options.to?.trim() || options.subject?.trim(),
  );

  let url: string;
  let mode: 'search' | 'filter';

  if (needsTextSearch) {
    mode = 'search';
    const clauses: string[] = [];

    if (options.query?.trim()) clauses.push(kqlValue(options.query));
    if (options.from?.trim()) clauses.push(`from:${kqlFieldValue(options.from)}`);
    if (options.to?.trim()) clauses.push(`to:${kqlFieldValue(options.to)}`);
    if (options.subject?.trim())
      clauses.push(`subject:${kqlFieldValue(options.subject)}`);
    if (options.hasAttachments === true) clauses.push('hasAttachment:true');

    clauses.push(`${kqlDateField}>=${ymd(since)}`);
    if (until) clauses.push(`${kqlDateField}<=${ymd(until)}`);

    const kql = clauses.join(' AND ');
    url =
      `${basePath}?$search=${encodeURIComponent(`"${kql}"`)}` +
      `&$top=${limit}&$select=${SELECT_FIELDS}`;

    notes.push(
      'Metin aramasi kullanildi (KQL). Graph bu modda sonuclari tarihe gore ' +
        'degil alaka duzeyine gore siralar ve tarih siniri gun hassasiyetindedir.',
    );
    if (options.hasAttachments === false) {
      notes.push(
        "Metin aramasi modunda 'hasAttachments: false' Graph tarafindan " +
          'desteklenmiyor; bu filtre yok sayildi.',
      );
    }
  } else {
    mode = 'filter';
    const filters: string[] = [`${odataDateField} ge ${since.toISOString()}`];
    if (until) filters.push(`${odataDateField} le ${until.toISOString()}`);
    if (options.hasAttachments !== undefined) {
      filters.push(`hasAttachments eq ${options.hasAttachments}`);
    }
    if (options.from?.trim()) {
      filters.push(
        `from/emailAddress/address eq '${odataLiteral(options.from.trim())}'`,
      );
    }

    url =
      `${basePath}?$filter=${encodeURIComponent(filters.join(' and '))}` +
      `&$orderby=${odataDateField}%20desc&$top=${limit}&$select=${SELECT_FIELDS}`;

    notes.push(
      `Sonuclar ${odataDateField} alanina gore yeniden eskiye siralandi. ` +
        'Sayfalama icin nextCursor degerini cursor parametresiyle geri gonderin.',
    );
  }

  const response = await graphFetch<{
    value?: GraphMessage[];
    '@odata.nextLink'?: string;
  }>(url);

  return {
    mailbox: options.mailbox,
    folder: folderLabel,
    mode,
    windowStart: since.toISOString(),
    windowEnd: until ? until.toISOString() : null,
    count: response.value?.length ?? 0,
    messages: (response.value ?? []).map(toSummary),
    nextCursor: response['@odata.nextLink'] ?? null,
    notes,
  };
}

export interface FullMessage extends MessageSummary {
  bodyContentType: string;
  body: string;
  truncated: boolean;
}

const MAX_BODY_CHARS = 60_000;

export async function getMessage(
  mailbox: string,
  messageId: string,
  bodyFormat: 'text' | 'html',
): Promise<FullMessage> {
  const message = await graphFetch<GraphMessage>(
    `/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(messageId)}?$select=${SELECT_FIELDS},body`,
    { headers: { Prefer: `outlook.body-content-type="${bodyFormat}"` } },
  );

  const raw = message.body?.content ?? '';
  const truncated = raw.length > MAX_BODY_CHARS;

  return {
    ...toSummary(message),
    bodyContentType: message.body?.contentType ?? bodyFormat,
    body: truncated ? `${raw.slice(0, MAX_BODY_CHARS)}\n\n[... govde kisaltildi ...]` : raw,
    truncated,
  };
}

export interface AttachmentInfo {
  id: string;
  name: string;
  contentType: string;
  size: number;
  isInline: boolean;
}

export async function listAttachments(
  mailbox: string,
  messageId: string,
): Promise<AttachmentInfo[]> {
  const response = await graphFetch<{
    value?: {
      id: string;
      name?: string;
      contentType?: string;
      size?: number;
      isInline?: boolean;
    }[];
  }>(
    `/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(messageId)}/attachments?$select=id,name,contentType,size,isInline`,
  );

  return (response.value ?? []).map((attachment) => ({
    id: attachment.id,
    name: attachment.name ?? '(isimsiz)',
    contentType: attachment.contentType ?? 'application/octet-stream',
    size: attachment.size ?? 0,
    isInline: Boolean(attachment.isInline),
  }));
}

export interface AttachmentContent extends AttachmentInfo {
  base64: string;
}

export async function getAttachment(
  mailbox: string,
  messageId: string,
  attachmentId: string,
): Promise<AttachmentContent> {
  const attachment = await graphFetch<{
    id: string;
    name?: string;
    contentType?: string;
    size?: number;
    isInline?: boolean;
    contentBytes?: string;
    '@odata.type'?: string;
  }>(
    `/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
  );

  if (!attachment.contentBytes) {
    throw new Error(
      `Bu ek dosya icerigi olarak indirilemiyor (tur: ${attachment['@odata.type'] ?? 'bilinmiyor'}). ` +
        'Yalnizca fileAttachment turundeki ekler desteklenir; itemAttachment ve referenceAttachment desteklenmez.',
    );
  }

  const size = attachment.size ?? 0;
  if (size > config.maxAttachmentBytes) {
    throw new Error(
      `Ek cok buyuk (${size} bayt). Sunucu siniri ${config.maxAttachmentBytes} bayt. ` +
        'Gerekirse MCP_MAX_ATTACHMENT_BYTES degerini yukseltin.',
    );
  }

  return {
    id: attachment.id,
    name: attachment.name ?? '(isimsiz)',
    contentType: attachment.contentType ?? 'application/octet-stream',
    size,
    isInline: Boolean(attachment.isInline),
    base64: attachment.contentBytes,
  };
}

export interface SendMailOptions {
  mailbox: string;
  to: string[];
  cc?: string[] | undefined;
  subject: string;
  body: string;
  bodyType: 'text' | 'html';
  replyToMessageId?: string | undefined;
}

export async function sendMail(options: SendMailOptions): Promise<void> {
  const recipients = (list: string[]) =>
    list.map((address) => ({ emailAddress: { address } }));

  if (options.replyToMessageId) {
    await graphFetch(
      `/users/${encodeURIComponent(options.mailbox)}/messages/${encodeURIComponent(options.replyToMessageId)}/reply`,
      {
        method: 'POST',
        body: {
          message: {
            toRecipients: recipients(options.to),
            ...(options.cc?.length ? { ccRecipients: recipients(options.cc) } : {}),
          },
          comment: options.body,
        },
      },
    );
    return;
  }

  await graphFetch(`/users/${encodeURIComponent(options.mailbox)}/sendMail`, {
    method: 'POST',
    body: {
      message: {
        subject: options.subject,
        body: { contentType: options.bodyType, content: options.body },
        toRecipients: recipients(options.to),
        ...(options.cc?.length ? { ccRecipients: recipients(options.cc) } : {}),
      },
      saveToSentItems: true,
    },
  });
}
