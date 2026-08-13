# Outlook MCP Server — tek dosya sürümü

Bu paket, `mcp-outlook` sunucusunun **derlenmiş** halidir. TypeScript kaynak dosyaları ve
tüm bağımlılıklar (express, MCP SDK, zod) tek bir `server.mjs` dosyasına gömülmüştür.

**Neden bu sürüm var:** GitHub'ın web arayüzü klasör yüklemeyi yalnızca masaüstü
tarayıcıda, sürükle-bırak ile destekler. Telefondan klasör yükleyemezsiniz. Bu sürümde
klasör yok — yükleyeceğiniz **2 gevşek dosya** var, ikisini de tek tek seçebilirsiniz.

Kaynak kodu düzenlemek isterseniz tam sürümü (`src/` klasörlü) kullanın.

---

## Depoya ne yükleyeceksiniz

Sadece bu iki dosya, **deponun kökünde**:

```
package.json
server.mjs
```

Depoda başka dosya kalmasın. Önceki denemeden kalan `tsconfig.json`,
`package-lock.json` ve `render.yaml` dosyalarını **silin** — `tsconfig.json` kalırsa
sorun çıkarmaz ama gereksizdir, kafa karıştırır.

GitHub'da bir dosyayı silmek için: dosyaya dokunun → sağ üstteki `...` → `Delete file`
→ `Commit changes`.

---

## Render ayarları

Servis zaten kuruluysa `Settings` altından şu iki alanı değiştirmeniz yeterli:

| Alan | Değer |
|---|---|
| Build Command | `npm install` |
| Start Command | `npm start` |

Derleme adımı yok, çünkü kod zaten derlenmiş. `npm install` hiçbir paket indirmez
(bağımlılık yok), saniyeler sürer.

Ortam değişkenleri değişmedi — beşi de aynen kalsın:

| Anahtar | Değer |
|---|---|
| `AZURE_TENANT_ID` | (aynı) |
| `AZURE_CLIENT_ID` | (aynı) |
| `AZURE_CLIENT_SECRET` | (aynı) |
| `MCP_AUTH_TOKEN` | (aynı) |
| `MCP_MAILBOXES` | `finans@rsresearch.net` |

`PORT` girmeyin.

Değişiklikleri kaydettikten sonra `Manual Deploy` → `Clear build cache & deploy`.

---

## Çalıştığını doğrulama

```bash
curl https://<servis-adi>.onrender.com/healthz
```

Beklenen yanıt:

```json
{"status":"ok","server":"outlook-mcp","version":"1.0.0","mailboxes":1,"sendingEnabled":false}
```

`mailboxes` alanı `1` görünmüyorsa `MCP_MAILBOXES` değişkeni girilmemiş demektir.

---

## Bu dosyayı yeniden üretmek

Tam sürümün (`src/` klasörlü) içinde:

```bash
npm install
npm run bundle      # dist-single/server.mjs olusturur
```

Kaynak kodda bir değişiklik yaptığınızda bu komutu çalıştırıp yeni `server.mjs`
dosyasını depoya yükleyin.

---

## Sorun giderme

| Belirti | Sebep ve çözüm |
|---|---|
| `TS18003: No inputs were found` | Depoda hâlâ `tsconfig.json` var ve Build Command `npm run build` çalıştırıyor. Build Command'ı `npm install` yapın. |
| `Cannot find module` | `server.mjs` eksik veya yarım yüklenmiş. Dosya ~1.9 MB olmalı; GitHub'da boyutunu kontrol edin. |
| `MCP_AUTH_TOKEN ... en az 24 karakter` | Ortam değişkeni girilmemiş veya çok kısa. |
| `401` | İstek `Authorization: Bearer <token>` başlığı olmadan geldi. |
| `403 Graph erişimi reddedildi` | Kutu app-only erişime kapalı. Tam sürümün README'sinde bölüm 1'e bakın. |
