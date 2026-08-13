/**
 * Microsoft Graph app-only (client credentials) istemcisi.
 *
 * Bilerek Replit'e ozgu hicbir SDK kullanilmiyor: bu dosya Render, Fly, Railway
 * veya herhangi bir Node ortaminda aynen calisir.
 */
import { config } from './config.js';

const GRAPH_ORIGIN = 'https://graph.microsoft.com';
const GRAPH_API_VERSION = 'v1.0';
const GRAPH_BASE = `${GRAPH_ORIGIN}/${GRAPH_API_VERSION}`;

let tokenCache: { token: string; expiresAt: number } | null = null;

export async function getAppOnlyToken(): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expiresAt - 60_000) {
    return tokenCache.token;
  }

  const response = await fetch(
    `https://login.microsoftonline.com/${config.tenantId}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: config.clientId,
        client_secret: config.clientSecret,
        scope: 'https://graph.microsoft.com/.default',
      }),
    },
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Azure token istegi basarisiz (${response.status}): ${body}`);
  }

  const data = (await response.json()) as {
    access_token?: string;
    expires_in?: number;
  };

  if (!data.access_token) {
    throw new Error('Azure token yaniti access_token icermiyor.');
  }

  tokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
  };
  return tokenCache.token;
}

export class GraphError extends Error {
  constructor(
    readonly status: number,
    readonly graphCode: string | null,
    message: string,
  ) {
    super(message);
    this.name = 'GraphError';
  }
}

/**
 * Graph'a istek atar.
 *
 * `path` YALNIZCA `/users/...` gibi, `/v1.0` sonrasina goreli bir yol olabilir.
 * Mutlak URL kabul edilmez — aksi halde disaridan gelen bir deger (ornegin
 * sayfalama imleci) Azure app-only token'inin saldirgan kontrolundeki bir
 * adrese gonderilmesine yol acardi. Graph'in dondurdugu @odata.nextLink
 * degerlerini once `graphPathFromNextLink()` ile dogrulayin.
 */
export async function graphFetch<T>(
  path: string,
  init: {
    method?: 'GET' | 'POST';
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
): Promise<T> {
  if (!path.startsWith('/') || path.startsWith('//')) {
    throw new Error(
      `Gecersiz Graph yolu: '${path.slice(0, 80)}'. Yalnizca '/' ile baslayan goreli yollar kabul edilir.`,
    );
  }

  const token = await getAppOnlyToken();
  const url = `${GRAPH_BASE}${path}`;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    ...(init.headers ?? {}),
  };
  let payload: string | undefined;
  if (init.body !== undefined) {
    payload = JSON.stringify(init.body);
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(url, {
    method: init.method ?? 'GET',
    headers,
    ...(payload !== undefined ? { body: payload } : {}),
  });

  if (response.status === 204) {
    return undefined as T;
  }

  const text = await response.text();

  if (!response.ok) {
    let code: string | null = null;
    let detail = text;
    try {
      const parsed = JSON.parse(text) as {
        error?: { code?: string; message?: string };
      };
      code = parsed.error?.code ?? null;
      detail = parsed.error?.message ?? text;
    } catch {
      // Graph her zaman JSON dondurmez; ham metni kullan.
    }

    if (response.status === 403) {
      throw new GraphError(
        403,
        code,
        `Graph erisimi reddedildi (403). Bu genellikle iki sebepten olur: ` +
          `(1) Azure uygulamasina gerekli Application izni verilmemis veya admin ` +
          `onayi alinmamis, (2) M365 tenant'inda bir ApplicationAccessPolicy bu ` +
          `posta kutusunu app-only erisime kapatmis. Graph mesaji: ${detail}`,
      );
    }
    if (response.status === 404) {
      throw new GraphError(
        404,
        code,
        `Graph kaydi bulunamadi (404). Posta kutusu adresi veya mesaj kimligi ` +
          `hatali olabilir. Graph mesaji: ${detail}`,
      );
    }
    if (response.status === 429) {
      const retryAfter = response.headers.get('Retry-After');
      throw new GraphError(
        429,
        code,
        `Graph hiz siniri asildi. ${retryAfter ? `${retryAfter} saniye sonra tekrar deneyin.` : 'Kisa bir sure sonra tekrar deneyin.'}`,
      );
    }

    throw new GraphError(
      response.status,
      code,
      `Graph istegi basarisiz (${response.status}): ${detail}`,
    );
  }

  if (!text) {
    return undefined as T;
  }
  return JSON.parse(text) as T;
}

/**
 * Istemcinin verdigi posta kutusu adresini izin listesine karsi dogrular.
 *
 * Bu kontrol guvenlik acisindan kritik: app-only token tum tenant'a erisebilir,
 * dolayisiyla bu allowlist olmadan bir LLM istedigi calisanin kutusunu okuyabilir.
 */
/**
 * Graph'in dondurdugu bir @odata.nextLink degerini dogrular ve `/v1.0` sonrasina
 * goreli, guvenli bir yola cevirir.
 *
 * Bu imlec degeri istemciden geri geliyor, yani dusman kontrolunde sayilmali.
 * Uc sey dogrulaniyor:
 *  1. Adres gercekten Graph'in kendi origin'i mi (token sizdirmaya karsi),
 *  2. Yol /v1.0/users/<kutu>/ kalibinda mi,
 *  3. Oradaki kutu hem izin listesinde hem de cagirinin sectigi kutu mu
 *     (baska bir kutuya yatay gecise karsi).
 *
 * `new URL()` yolu normallestirdigi icin '../' gibi kacislar bu noktada zaten
 * cozulmus olur; kontroller normallestirilmis yol uzerinde yapilir.
 */
export function graphPathFromNextLink(
  rawUrl: string,
  expectedMailbox: string,
): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(
      'cursor gecerli bir URL degil. Yalnizca onceki aramanin dondurdugu ' +
        'nextCursor degerini oldugu gibi geri gonderin.',
    );
  }

  if (parsed.origin !== GRAPH_ORIGIN) {
    throw new Error(
      `cursor yalnizca ${GRAPH_ORIGIN} adresine isaret edebilir, alinan: ${parsed.origin}`,
    );
  }

  const segments = parsed.pathname.split('/');
  if (segments[1] !== GRAPH_API_VERSION || segments[2] !== 'users' || !segments[3]) {
    throw new Error(
      `cursor beklenen /${GRAPH_API_VERSION}/users/<kutu>/... kalibinda degil.`,
    );
  }

  let cursorMailbox: string;
  try {
    cursorMailbox = decodeURIComponent(segments[3]);
  } catch {
    throw new Error('cursor icindeki posta kutusu bolumu cozulemedi.');
  }

  // Izin listesi kontrolu (listede yoksa burada patlar).
  const allowed = resolveMailbox(cursorMailbox);

  if (allowed.toLowerCase() !== expectedMailbox.toLowerCase()) {
    throw new Error(
      `cursor '${allowed}' kutusuna ait ama istek '${expectedMailbox}' kutusu icin yapildi.`,
    );
  }

  return `${parsed.pathname.slice(`/${GRAPH_API_VERSION}`.length)}${parsed.search}`;
}

export function resolveMailbox(requested?: string | null): string {
  if (!requested || !requested.trim()) {
    return config.defaultMailbox;
  }
  const wanted = requested.trim().toLowerCase();
  const match = config.mailboxes.find(
    (mailbox) => mailbox.toLowerCase() === wanted,
  );
  if (!match) {
    throw new Error(
      `'${requested}' bu sunucuda izinli bir posta kutusu degil. ` +
        `Izinli kutular: ${config.mailboxes.join(', ')}. ` +
        `Yeni kutu eklemek icin MCP_MAILBOXES ortam degiskenini guncelleyin.`,
    );
  }
  return match;
}
