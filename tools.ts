/**
 * MCP arac tanimlari. Aciklamalar bilerek ayrintili: Claude bu metinleri okuyup
 * hangi araci hangi parametreyle cagiracagina karar veriyor.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { config } from './config.js';
import { resolveMailbox } from './graph.js';
import {
  getAttachment,
  getMessage,
  listAttachments,
  listFolders,
  searchMessages,
  sendMail,
} from './mail.js';

function jsonResult(payload: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

function errorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [{ type: 'text' as const, text: `Hata: ${message}` }],
  };
}

const mailboxArg = z
  .string()
  .optional()
  .describe(
    `Okunacak posta kutusu adresi. Bos birakilirsa '${config.defaultMailbox}' kullanilir. ` +
      `Izinli kutular: ${config.mailboxes.join(', ')}.`,
  );

export function registerTools(server: McpServer): void {
  server.registerTool(
    'list_mailboxes',
    {
      title: 'Posta kutularini listele',
      description:
        'Bu sunucunun erisebildigi posta kutularini, varsayilan tarih penceresini ' +
        've yazma izinlerinin acik olup olmadigini dondurur. Diger araclari ' +
        'kullanmadan once buradan baslamak faydalidir.',
      inputSchema: {},
    },
    async () =>
      jsonResult({
        mailboxes: config.mailboxes,
        defaultMailbox: config.defaultMailbox,
        defaultLookbackDays: config.lookbackDays,
        maxPageSize: config.maxPageSize,
        sendingEnabled: config.allowSend,
        sendMailbox: config.sendMailbox,
      }),
  );

  server.registerTool(
    'list_folders',
    {
      title: 'Posta klasorlerini listele',
      description:
        'Posta kutusundaki klasorleri iki seviye derinlige kadar listeler ve her ' +
        "biri icin 'id' dondurur. search_mail aracina standart olmayan bir klasor " +
        'vermek istediginizde once bu araci calistirip donen id degerini kullanin.',
      inputSchema: { mailbox: mailboxArg },
    },
    async ({ mailbox }) => {
      try {
        const target = resolveMailbox(mailbox);
        const folders = await listFolders(target);
        return jsonResult({ mailbox: target, folderCount: folders.length, folders });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'search_mail',
    {
      title: 'E-postalarda ara',
      description:
        'Posta kutusunda e-posta arar. Gonderilen postalar icin folder="sentitems", ' +
        'gelen kutusu icin folder="inbox" verin; folder bos birakilirsa tum kutu taranir.\n\n' +
        `Tarih verilmezse son ${config.lookbackDays} gun taranir (yaklasik 2 yil). ` +
        'Daha eskiye gitmek icin since parametresini acikca verin.\n\n' +
        'Iki calisma modu vardir ve arac bunu otomatik secer:\n' +
        '- query, to veya subject verilirse metin aramasi (KQL) yapilir. Bu modda ' +
        'sonuclar alaka duzeyine gore siralanir, tarihe gore degil.\n' +
        '- yalnizca tarih/from/hasAttachments verilirse filtre modu calisir ve ' +
        'sonuclar en yeniden en eskiye siralanir.\n\n' +
        'Sonuc sayfalidir. Daha fazlasi icin donen nextCursor degerini bir sonraki ' +
        'cagrida cursor parametresine gecirin. Iki yillik dokumu tek cagrida ' +
        'beklemeyin; sayfa sayfa ilerleyin.',
      inputSchema: {
        mailbox: mailboxArg,
        folder: z
          .string()
          .optional()
          .describe(
            "Klasor. Standart isimler: 'sentitems' (gonderilenler), 'inbox', " +
              "'drafts', 'archive', 'deleteditems'. Ozel klasorler icin " +
              'list_folders ciktisindaki id degerini kullanin. Bos = tum kutu.',
          ),
        query: z
          .string()
          .optional()
          .describe(
            'Serbest metin aramasi. Konu ve govdede aranir. Ornek: "fatura odeme".',
          ),
        from: z
          .string()
          .optional()
          .describe('Gonderen e-posta adresi veya adres parcasi.'),
        to: z
          .string()
          .optional()
          .describe(
            'Alici e-posta adresi. Bu parametre verildiginde metin arama modu devreye girer.',
          ),
        subject: z.string().optional().describe('Konu satirinda gecen ifade.'),
        since: z
          .string()
          .optional()
          .describe(
            `Baslangic tarihi (ISO 8601, orn. 2024-08-01). Varsayilan: bugunden ${config.lookbackDays} gun once.`,
          ),
        until: z
          .string()
          .optional()
          .describe('Bitis tarihi (ISO 8601). Bos birakilirsa bugune kadar.'),
        hasAttachments: z
          .boolean()
          .optional()
          .describe('true verilirse yalnizca ekli mesajlar dondurulur.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(config.maxPageSize)
          .optional()
          .describe(`Sayfa basina mesaj sayisi. Varsayilan 25, en fazla ${config.maxPageSize}.`),
        cursor: z
          .string()
          .optional()
          .describe(
            'Onceki sonucun nextCursor degeri. Verildiginde diger tum filtreler yok sayilir.',
          ),
      },
    },
    async (args) => {
      try {
        const target = resolveMailbox(args.mailbox);
        const result = await searchMessages({ ...args, mailbox: target });
        return jsonResult(result);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'get_message',
    {
      title: 'E-posta govdesini oku',
      description:
        'Tek bir e-postanin tam govdesini ve basliklarini dondurur. messageId ' +
        'degerini search_mail sonucundaki id alanindan alin. Cok uzun govdeler ' +
        'kisaltilir ve truncated=true olarak isaretlenir.',
      inputSchema: {
        mailbox: mailboxArg,
        messageId: z.string().describe('search_mail sonucundaki mesaj id degeri.'),
        bodyFormat: z
          .enum(['text', 'html'])
          .optional()
          .describe(
            "Govde bicimi. Varsayilan 'text' — okunmasi cok daha kolaydir, " +
              "HTML'e yalnizca bicimlendirme onemliyse gecin.",
          ),
      },
    },
    async ({ mailbox, messageId, bodyFormat }) => {
      try {
        const target = resolveMailbox(mailbox);
        const message = await getMessage(target, messageId, bodyFormat ?? 'text');
        return jsonResult(message);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'list_attachments',
    {
      title: 'Ekleri listele',
      description:
        'Bir e-postanin eklerini ad, tur ve boyut bilgisiyle listeler. Icerik ' +
        'indirmez; dosyayi almak icin get_attachment kullanin.',
      inputSchema: {
        mailbox: mailboxArg,
        messageId: z.string().describe('Mesaj id degeri.'),
      },
    },
    async ({ mailbox, messageId }) => {
      try {
        const target = resolveMailbox(mailbox);
        const attachments = await listAttachments(target, messageId);
        return jsonResult({ mailbox: target, messageId, attachments });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'get_attachment',
    {
      title: 'Ek dosyasini indir',
      description:
        'Bir eki base64 icerigiyle birlikte dondurur. Once list_attachments ile ' +
        `boyutu kontrol edin: ${config.maxAttachmentBytes} bayttan buyuk ekler ` +
        'reddedilir. Yalnizca gercek dosya ekleri desteklenir.',
      inputSchema: {
        mailbox: mailboxArg,
        messageId: z.string().describe('Mesaj id degeri.'),
        attachmentId: z.string().describe('list_attachments sonucundaki ek id degeri.'),
      },
    },
    async ({ mailbox, messageId, attachmentId }) => {
      try {
        const target = resolveMailbox(mailbox);
        const attachment = await getAttachment(target, messageId, attachmentId);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  name: attachment.name,
                  contentType: attachment.contentType,
                  size: attachment.size,
                },
                null,
                2,
              ),
            },
            {
              type: 'resource' as const,
              resource: {
                uri: `outlook://${target}/messages/${messageId}/attachments/${attachment.id}`,
                mimeType: attachment.contentType,
                blob: attachment.base64,
              },
            },
          ],
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  if (!config.allowSend) {
    return;
  }

  server.registerTool(
    'send_mail',
    {
      title: 'E-posta gonder',
      description:
        `${config.sendMailbox} kutusundan e-posta gonderir. Bu geri alinamaz bir ` +
        'islemdir: aracı cagirmadan once alici, konu ve govdeyi kullaniciya ' +
        'dogrulatin. replyToMessageId verilirse yeni posta yerine mevcut mesaja ' +
        'yanit gonderilir.',
      inputSchema: {
        to: z.array(z.string()).min(1).describe('Alici e-posta adresleri.'),
        cc: z.array(z.string()).optional().describe('Bilgi alicilari.'),
        subject: z
          .string()
          .describe('Konu satiri. Yanit gonderirken yok sayilir.'),
        body: z.string().describe('Mesaj govdesi.'),
        bodyType: z
          .enum(['text', 'html'])
          .optional()
          .describe("Govde bicimi, varsayilan 'text'."),
        replyToMessageId: z
          .string()
          .optional()
          .describe('Doldurulursa bu mesaja yanit olarak gonderilir.'),
      },
    },
    async ({ to, cc, subject, body, bodyType, replyToMessageId }) => {
      try {
        const sender = config.sendMailbox;
        if (!sender) {
          throw new Error('MCP_SEND_MAILBOX tanimli degil.');
        }
        await sendMail({
          mailbox: sender,
          to,
          cc,
          subject,
          body,
          bodyType: bodyType ?? 'text',
          replyToMessageId,
        });
        return jsonResult({
          status: 'gonderildi',
          from: sender,
          to,
          cc: cc ?? [],
          subject: replyToMessageId ? '(yanit)' : subject,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
