/**
 * HTTP giris noktasi.
 *
 * Streamable HTTP transport'u "stateless" modda calistiriyoruz: her JSON-RPC
 * istegi icin yeni bir McpServer + transport ureilip istek bitince kapatiliyor.
 * Bunun sebebi pratik — Render/Replit gibi ortamlarda surec her an yeniden
 * baslatilabilir veya birden fazla ornek calisabilir; oturum durumu bellekte
 * tutulursa istemci "session not found" hatalarina duser.
 */
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express, { type NextFunction, type Request, type Response } from 'express';

import { config } from './config.js';
import { registerTools } from './tools.js';

const SERVER_INFO = {
  name: 'outlook-mcp',
  version: '1.0.0',
} as const;

function log(level: 'info' | 'warn' | 'error', message: string, extra?: unknown) {
  const line = { level, time: new Date().toISOString(), message, ...(extra ? { extra } : {}) };
  console[level === 'info' ? 'log' : level](JSON.stringify(line));
}

/**
 * Sabit zamanli token karsilastirmasi.
 *
 * Once iki degeri de SHA-256'dan geciriyoruz: boylece karsilastirilan tamponlar
 * her zaman 32 bayt olur ve erken donus yapan bir uzunluk dali kalmaz. Ham
 * dizeleri dogrudan karsilastirmak, uzunluk farkinda kisa devre yaparak
 * token'in uzunlugunu sizdirirdi.
 */
const expectedTokenDigest = createHash('sha256')
  .update(config.authToken, 'utf8')
  .digest();

function tokenMatches(candidate: string): boolean {
  const candidateDigest = createHash('sha256').update(candidate, 'utf8').digest();
  return timingSafeEqual(expectedTokenDigest, candidateDigest);
}

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.header('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());

  if (!match?.[1] || !tokenMatches(match[1].trim())) {
    log('warn', 'Yetkisiz istek reddedildi', {
      ip: req.ip,
      path: req.path,
      hasHeader: Boolean(header),
    });
    res.status(401).json({
      jsonrpc: '2.0',
      error: {
        code: -32001,
        message:
          'Yetkisiz. Authorization: Bearer <MCP_AUTH_TOKEN> basligi gerekli.',
      },
      id: null,
    });
    return;
  }
  next();
}

function buildServer(): McpServer {
  const server = new McpServer(SERVER_INFO, {
    instructions:
      'Bu sunucu bir Microsoft 365 posta kutusuna salt-okunur (yapilandirmaya ' +
      'gore yazma da acik olabilir) erisim saglar. Once list_mailboxes ile ' +
      'kapsami ogrenin, sonra search_mail ile arayin ve get_message ile tek tek ' +
      'okuyun. Arama sonuclari sayfalidir; nextCursor doluysa devami vardir.',
  });
  registerTools(server);
  return server;
}

async function main(): Promise<void> {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '4mb' }));

  app.get('/healthz', (_req, res) => {
    res.json({
      status: 'ok',
      server: SERVER_INFO.name,
      version: SERVER_INFO.version,
      mailboxes: config.mailboxes.length,
      sendingEnabled: config.allowSend,
    });
  });

  app.get('/', (_req, res) => {
    res.type('text/plain').send(
      `${SERVER_INFO.name} v${SERVER_INFO.version}\n` +
        'MCP ucu: POST /mcp (Streamable HTTP)\n' +
        'Kimlik dogrulama: Authorization: Bearer <token>\n',
    );
  });

  app.post('/mcp', requireAuth, async (req: Request, res: Response) => {
    const requestId = randomUUID();
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
      enableJsonResponse: true,
    });

    res.on('close', () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      log('error', 'MCP istegi islenemedi', {
        requestId,
        error: error instanceof Error ? error.message : String(error),
      });
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Sunucu ic hatasi' },
          id: null,
        });
      }
    }
  });

  // Stateless modda sunucudan istemciye kendiliginden mesaj gitmez; bu yuzden
  // GET (SSE akisi) ve DELETE (oturum kapatma) desteklenmiyor. Istemcilerin
  // sessizce beklememesi icin acik bir yanit donuyoruz.
  const notSupported = (_req: Request, res: Response) => {
    res.status(405).json({
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: 'Bu sunucu stateless calisir; yalnizca POST /mcp desteklenir.',
      },
      id: null,
    });
  };
  app.get('/mcp', requireAuth, notSupported);
  app.delete('/mcp', requireAuth, notSupported);

  app.listen(config.port, '0.0.0.0', () => {
    log('info', 'Outlook MCP sunucusu calisiyor', {
      port: config.port,
      mailboxes: config.mailboxes,
      lookbackDays: config.lookbackDays,
      sendingEnabled: config.allowSend,
    });
  });
}

main().catch((error) => {
  log('error', 'Sunucu baslatilamadi', {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
