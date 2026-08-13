# Outlook MCP Sunucusu

Microsoft 365 posta kutusunu **MCP (Model Context Protocol)** üzerinden internete açan,
tek başına çalışan bir Node servisi. Claude Desktop bu sunucuya bağlanıp posta kutusunda
arama yapabilir, mesajları okuyabilir, ekleri indirebilir ve (açıkça izin verilirse)
mail gönderebilir.

Ana projeden (`parasut-ops-panel`) **tamamen bağımsızdır**: Replit'e özgü hiçbir SDK
kullanmaz, kendi `package.json` dosyası vardır. Render, Railway, Fly veya yeni bir Replit
projesinde aynen çalışır.

---

## 1. Önce şunu bilin: hangi posta kutusuna erişilebilir?

Bu sunucu **app-only** (client credentials) kimlik doğrulaması kullanır. Microsoft 365
tenant'ında bir **ApplicationAccessPolicy** hangi kutulara app-only erişilebileceğini
sınırlar. Test edilmiş güncel durum:

| Posta kutusu | App-only okuma | App-only gönderme |
|---|---|---|
| `finans@rsresearch.net` | ✅ Çalışıyor | ❌ 403 |
| `omererdogan@rsresearch.net` | ❌ 403 (`Access is denied`) | ❌ 403 |

Yani bu sunucu **bulutta bir yerde çalıştığında yalnızca `finans@` kutusunu okuyabilir.**

`omererdogan@` kutusunu da okumak istiyorsanız iki seçenek var:

1. **Tenant yöneticisinden politikayı genişletmesini isteyin.** Doğru çözüm budur ve
   sunucuda hiçbir kod değişikliği gerektirmez. Yöneticinin çalıştıracağı komut
   (Exchange Online PowerShell):

   ```powershell
   # Mevcut politikayı gör
   Get-ApplicationAccessPolicy | Format-List AppId,PolicyScopeGroupId,AccessRight

   # İzin verilen kullanıcı grubuna omererdogan@ ekleyin (grup adı tenant'a göre değişir)
   Add-DistributionGroupMember -Identity "<mcp-izinli-kutular-grubu>" `
     -Member omererdogan@rsresearch.net

   # Doğrulama
   Test-ApplicationAccessPolicy -Identity omererdogan@rsresearch.net -AppId <AZURE_CLIENT_ID>
   ```

   Sonuç `AccessCheckResult: Granted` dönerse `MCP_MAILBOXES` listesine adresi ekleyip
   servisi yeniden başlatmanız yeterli.

2. **Yalnızca `finans@` ile devam edin.** Hiçbir şey yapmanıza gerek yok, varsayılan bu.

> Gönderme (`MCP_ALLOW_SEND`) varsayılan olarak **kapalıdır** ve açsanız bile `finans@`
> kutusundan app-only gönderim 403 döner. Gönderim gerekiyorsa Azure uygulamasına
> `Mail.Send` **Application** izni verilmeli, admin onayı alınmalı ve erişim politikası
> o kutuyu kapsamalıdır.

---

## 2. Araçlar

| Araç | Ne yapar |
|---|---|
| `list_mailboxes` | Erişilebilen kutuları, varsayılan tarih penceresini ve yazma iznini döner |
| `list_folders` | Klasörleri iki seviye derinliğe kadar, `id` değerleriyle listeler |
| `search_mail` | E-posta arar (klasör, tarih aralığı, gönderen, alıcı, konu, ek filtresi) |
| `get_message` | Tek mesajın tam gövdesini döner (varsayılan düz metin) |
| `list_attachments` | Ekleri ad/tür/boyut ile listeler |
| `get_attachment` | Eki base64 içerikle indirir |
| `send_mail` | Mail gönderir — yalnızca `MCP_ALLOW_SEND=true` ise kayıtlı olur |

### `search_mail` hakkında bilmeniz gereken iki şey

**a) İki mod vardır ve araç otomatik seçer.**

- `query`, `to` veya `subject` verilirse → **metin arama modu** (Graph KQL). Bu modda
  Graph sonuçları *alaka düzeyine* göre sıralar, tarihe göre değil; tarih sınırı da gün
  hassasiyetindedir.
- Yalnızca tarih / `from` / `hasAttachments` verilirse → **filtre modu**. Sonuçlar en
  yeniden en eskiye sıralanır.

Bu ayrım Graph'ın bir kısıtından geliyor: `$search` ile `$filter` ve `$orderby` aynı
istekte kullanılamaz.

**b) Sonuçlar sayfalıdır.** Varsayılan tarih penceresi son **730 gün (~2 yıl)**. Tek
çağrıda en fazla 100 mesaj döner. Devamı için dönen `nextCursor` değerini bir sonraki
çağrıda `cursor` parametresine geçirin. Claude bunu kendiliğinden yapar; siz sadece
"devam et" demeniz yeterli.

---

## 3. Yerelde çalıştırma

```bash
cd mcp-outlook
cp .env.example .env      # değerleri doldurun
npm install
npm run build
npm start
```

Sağlık kontrolü: `curl http://localhost:5000/healthz`

`MCP_AUTH_TOKEN` üretmek için: `openssl rand -hex 32`

---

## 4. Render.com'a kurulum (adım adım)

Render seçilmesinin sebebi: bu Replit projesinin `cloud_run` dağıtımı askıya alınmış
durumda ve açılması Replit Support gerektiriyor.

**Blueprint kullanmıyoruz.** Render'da Blueprint ücretli plan gerektiriyor. Bunun yerine
servisi elle bir **Web Service** olarak kuruyoruz; bu ücretsiz katmanda çalışır.
Depodaki `render.yaml` dosyası bu yüzden opsiyoneldir, aşağıdaki adımlarda kullanılmıyor.

1. **Kodu GitHub'a gönderin.** Render bir Git reposundan deploy eder. Bu klasörün
   içeriği **kendi başına bir deponun kökü** olacak şekilde tasarlandı: `package.json`
   ve `src/` doğrudan kökte durmalı.

   Alt klasör olarak tutarsanız sorun değil — aşağıdaki **Root Directory** alanına o
   klasörün adını yazarsınız.

2. **Render panelinde** `New` → `Web Service` → GitHub deponuzu bağlayıp seçin.
   (İsterseniz önce `New` → `Project` ile bir proje açıp servisi onun içine
   koyabilirsiniz; kurulum alanları birebir aynıdır.)

3. **Kurulum alanlarını doldurun:**

   | Alan | Değer |
   |---|---|
   | Name | `outlook-mcp` (adres bundan türer) |
   | Language / Runtime | `Node` |
   | Branch | `main` |
   | Region | `Frankfurt` (Türkiye'ye en yakın) |
   | Root Directory | **boş bırakın** (depo kökü) |
   | Build Command | `npm ci && npm run build` |
   | Start Command | `npm start` |
   | Instance Type | **Free** |

   Health Check Path alanını `Advanced` altında bulursanız `/healthz` yazın; ücretsiz
   katmanda görünmüyorsa boş bırakın, zorunlu değil.

4. **Ortam değişkenlerini girin.** Aynı sayfadaki `Environment Variables` bölümüne
   `Add Environment Variable` ile tek tek ekleyin:

   | Anahtar | Değer |
   |---|---|
   | `AZURE_TENANT_ID` | Ana projedekiyle aynı |
   | `AZURE_CLIENT_ID` | Ana projedekiyle aynı |
   | `AZURE_CLIENT_SECRET` | Ana projedekiyle aynı |
   | `MCP_AUTH_TOKEN` | `openssl rand -hex 32` çıktısı |
   | `MCP_MAILBOXES` | `finans@rsresearch.net` |

   `PORT` **girmeyin** — Render kendisi enjekte eder, elle girerseniz servis açılmaz.

   `MCP_AUTH_TOKEN`'ı bir yere kaydedin; Claude Desktop yapılandırmasında lazım olacak.

5. **`Create Web Service`** deyin ve ilk derlemeyi bekleyin (2–4 dakika). Sonra
   doğrulayın:

   ```bash
   curl https://<servis-adi>.onrender.com/healthz
   ```

   `{"status":"ok",...}` görmelisiniz.

### Ücretsiz katmanın tek gerçek dezavantajı

Free instance 15 dakika trafik almazsa uykuya geçer. Sonraki ilk istek servisi
uyandırır ve bu 30–60 saniye sürer — Claude bu sırada zaman aşımına düşüp "sunucuya
ulaşılamadı" diyebilir. İkinci deneme çalışır.

Bunu istemiyorsanız iki seçenek var:

- **Ücretsiz çözüm:** [cron-job.org](https://cron-job.org) gibi bir servisle 10 dakikada
  bir `https://<servis-adi>.onrender.com/healthz` adresine istek attırın. Servis hiç
  uyumaz. (Bu, aylık ücretsiz kullanım kotanızdan yer.)
- **Ücretli çözüm:** Render'da servisin Instance Type'ını `Starter`a yükseltin; hiç
  uyumaz.

### Alternatif: yeni bir Replit projesi

`mcp-outlook` klasörünü yeni bir Replit projesine kopyalayın, aynı ortam değişkenlerini
Secrets olarak girin (`PORT=5000`), çalıştırma komutunu `npm run build && npm start`
yapın ve projeyi **Autoscale Deployment** olarak yayınlayın. Adres
`https://<proje>.replit.app/mcp` olur. Adımlar aynıdır.

---

## 5. Claude Desktop'a bağlama

`claude_desktop_config.json` dosyası **yalnızca stdio** sunucuları kabul eder. Doğrudan
`"url": "..."` yazarsanız Claude Desktop girdiyi sessizce siler. Bu yüzden `mcp-remote`
adlı köprüyü kullanıyoruz: Claude Desktop ile stdio, sunucumuzla Streamable HTTP konuşur.

Dosyanın yeri:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

İçerik:

```json
{
  "mcpServers": {
    "outlook": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://<servis-adi>.onrender.com/mcp",
        "--transport",
        "http-only",
        "--header",
        "Authorization:${AUTH_HEADER}"
      ],
      "env": {
        "AUTH_HEADER": "Bearer BURAYA_MCP_AUTH_TOKEN"
      }
    }
  }
}
```

Üç ayrıntı önemli:

- `Authorization:${AUTH_HEADER}` ifadesinde **iki nokta üst üste sonrasında boşluk
  yoktur.** Claude Desktop argümanlardaki boşlukları bozar; bu yüzden token'ı `env`
  içine koyup değişken olarak enjekte ediyoruz. `Bearer` kelimesi `env` değerinin
  içindedir.
- `--transport http-only` şart: bu sunucu stateless çalışır, SSE akışı sunmaz.
  Bu bayrak olmadan `mcp-remote` önce SSE deneyip gereksiz yere bekler.
- Node 18+ kurulu olmalı (`npx` bunun için gerekli).

Kaydedin ve **Claude Desktop'ı tamamen kapatıp yeniden açın.** Ayarlar → Connectors
altında `outlook` görünmeli ve araçlar listelenmelidir.

Deneyin: *"finans kutusunda son 6 ayda gönderilen, konusunda fatura geçen mailleri listele."*

### Claude.ai (tarayıcı) veya mobil uygulama

Web arayüzündeki "Custom Connector" özelliği bearer token değil **OAuth 2.0** bekler.
Bu sunucu OAuth uygulamaz, dolayısıyla Claude.ai üzerinden doğrudan bağlanamazsınız.
Masaüstü uygulaması + `mcp-remote` yolunu kullanın.

---

## 6. Güvenlik

- **`MCP_AUTH_TOKEN` bir paroladır.** Onu bilen herkes `MCP_MAILBOXES` listesindeki
  kutuların tamamını okuyabilir. Sohbete, ekran görüntüsüne veya repoya yazmayın.
- **`MCP_MAILBOXES` bir güvenlik sınırıdır.** Azure app-only token teknik olarak
  tenant'taki her kutuya erişebilir; sunucu her istekte gelen adresi bu listeye karşı
  doğrular ve listede olmayanı reddeder. Listeyi dar tutun.
- **Yazma varsayılan olarak kapalıdır.** `MCP_ALLOW_SEND=true` yapmadıkça `send_mail`
  aracı Claude'a hiç gösterilmez.
- Token'ı değiştirmeniz gerekirse Render'da değeri güncelleyin, servisi yeniden
  başlatın ve `claude_desktop_config.json` içindeki değeri de güncelleyin.

---

## 7. Sorun giderme

| Belirti | Sebep ve çözüm |
|---|---|
| `401 Yetkisiz` | Token yanlış veya `Bearer ` öneki eksik. `env.AUTH_HEADER` değeri `Bearer ` ile başlamalı. |
| `Graph erişimi reddedildi (403)` | Kutu app-only erişime kapalı. Bölüm 1'deki tabloya ve PowerShell adımlarına bakın. |
| `An identifier was expected at position 0` | Arama metninde tırnak/parantez vardı. Sunucu bunları temizler; görüyorsanız sürüm eskidir, yeniden derleyin. |
| Claude Desktop'ta sunucu görünmüyor | Config'e `"url"` yazılmış olabilir — o satırı silin, `mcp-remote` biçimini kullanın ve uygulamayı tam kapatıp açın. |
| İlk istek zaman aşımına uğruyor | Render ücretsiz katmanı servisi uyutmuş. Starter plana geçin veya bir kez `curl /healthz` ile uyandırın. |
| `Graph hız sınırı aşıldı (429)` | Çok hızlı sayfalama yapıldı. Kısa bir süre bekleyip devam edin. |
| Sonuçlar tarih sırasında değil | Metin arama modundasınız (`query`/`to`/`subject` verilmiş). Tarih sıralaması istiyorsanız bu alanları boş bırakın. |
