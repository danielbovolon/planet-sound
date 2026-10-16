# Planet Sound — aggiornamento del 16 ottobre 2026

Condivisione (app, suono, collezioni, WAV) e pannelli in vetro sfocato.
È un aggiornamento **solo del sito** (GitHub Pages). **Il Worker Cloudflare non va toccato**: niente `wrangler deploy`, niente database.

## Cosa contiene lo zip

| File | Cosa fare |
|---|---|
| `index.html` | **sostituisce** quello nel repo |
| `sw.js` | **sostituisce** quello nel repo (nuova versione della cache) |
| `assets/css/glass.css` | **nuovo** |
| `assets/js/share.js` | **nuovo** |
| `assets/js/wav.js` | **nuovo** |

`app.js`, `app.css`, il Worker e tutti gli altri file restano come sono. `CNAME` non è nello zip e non si tocca.

## 1. Caricare i file (GitHub, dal browser)

1. Decomprimi lo zip sul computer. **Non caricare lo zip stesso**: servono i file e le cartelle al suo interno.
2. Apri il repository che serve `planetsound.danielbovolon.com` su github.com.
3. Clicca **Add file → Upload files**.
4. Trascina dentro, dalla cartella decompressa, **tutto il contenuto**: `index.html`, `sw.js` e la cartella `assets`. GitHub mantiene i percorsi (`assets/css/glass.css`, `assets/js/share.js`, `assets/js/wav.js`). Controlla l'elenco prima di confermare: devono comparire con quei percorsi.
5. Messaggio del commit, per esempio: `Share + glass panels`. Lascia **Commit directly to the main branch** e premi **Commit changes**.

Con git da terminale è lo stesso: copia i file nelle stesse posizioni, poi `git add -A && git commit -m "Share + glass panels" && git push`.

**Importante:** carica tutti e cinque i file nello stesso commit. `sw.js` elenca i file nuovi: se manca anche uno solo, il service worker non si installa e i telefoni restano sulla versione vecchia.

## 2. Attivazione

1. Vai su **Actions** nel repository: parte da solo "pages build and deployment". Aspetta la spunta verde (di solito 1–2 minuti).
2. Apri `https://planetsound.danielbovolon.com` su computer e fai una ricarica forzata: **Ctrl+Shift+R** (Windows/Linux) o **Cmd+Shift+R** (Mac).
3. **Sul telefono e nell'app installata sulla schermata Home** il sito è in cache per funzionare offline. La prima apertura dopo l'aggiornamento mostra ancora la versione vecchia e scarica la nuova in background. **Chiudi l'app del tutto e riaprila una seconda volta**: ora è quella nuova.
4. Se un dispositivo sembra bloccato sulla versione vecchia: su iPhone, Impostazioni → Safari → Avanzate → Dati dei siti web → `danielbovolon.com` → elimina; su Android/Chrome, tocca il lucchetto accanto all'indirizzo → Impostazioni sito → Cancella dati.

## 3. Prova che tutto funzioni (2 minuti)

1. **About → Share Planet Sound**: su telefono si apre il menu di condivisione, su computer copia il link ("Link copied").
2. Apri un suono → **Share sound**. Incolla il link in una nuova scheda: si apre direttamente il pannello di quel suono.
3. In un suono con il pulsante **Download** visibile → **Share WAV**. Controlla nome e descrizione, premi **Prepare WAV**, poi **Share…** (o **Download WAV** sul computer).
4. **Your archive →** a fianco di ogni collezione c'è **Share**; sotto i numeri c'è **Share my archive**. Apri il link: compare l'elenco, e un tocco apre il pannello del suono. Nell'**Index**, scegliendo una collezione compare **Share collection**.
5. Pannelli: apri un suono, poi "Your archive" e un dialog. La mappa deve vedersi sfocata attraverso il pannello, senza velo nero.

## Come funzionano le nuove opzioni

- **Share sound**: il link è `…/?no=12`, già gestito dall'app. Se il suono è privato, lo apre solo chi lo ha registrato.
- **Collezioni, archivio, album**: il link contiene il nome e i numeri dei suoni (`?album=Fiumi&nos=12,15,18`). Nel link entrano **solo i suoni pubblici**: quelli privati o rimossi vengono lasciati fuori, e l'app avvisa quanti. Chi apre il link vede l'elenco e può condividerlo a sua volta.
- **Share WAV**: compare **solo dove compare il pulsante Download**, cioè se l'autore ha attivato "Let others download the original recording" oppure il suono è tuo. Nel file finiscono nome e descrizione, scritti sia come descrizione Broadcast Wave (`bext`, la leggono Reaper, Pro Tools, Wavelab, BWF MetaEdit) sia come tag INFO (titolo, autore, commento, data). Se l'originale è già WAV, l'audio passa **senza modifiche**; se è FLAC viene convertito in WAV 24 bit senza perdite. Il file si prepara in un tocco e si condivide con un secondo tocco: è un obbligo dei browser per il menu di condivisione.
- **Vetro sfocato**: tutto in `glass.css`. Dove il dispositivo non supporta la sfocatura, o l'utente ha attivato "Riduci trasparenza" (dove il browser lo supporta), i pannelli tornano pieni come prima.

## Limiti da conoscere

- **Anteprima nei messaggi** (WhatsApp, Instagram, iMessage): il link di un singolo suono mostra l'anteprima generica di Planet Sound, non il titolo del suono. GitHub Pages serve una sola pagina. Per un'anteprima per suono servirebbe una piccola route nel Worker: si può aggiungere in un secondo momento.
- **Share WAV e file molto grandi**: oltre ~300 MB l'app non lo prepara (il browser deve tenere il file in memoria) e consiglia il link. Su iPhone, il FLAC può non essere decodificabile da Safari; in quel caso l'app lo dice e suggerisce un computer con Brave o Chrome.
- **Il registratore** ha lo stesso sfondo in vetro. Se su un telefono vecchio dovesse sembrare lento, apri `assets/css/glass.css` e cancella il blocco `.studio { … }`.

## Tornare indietro

Rimetti il `index.html` e il `sw.js` di prima (su GitHub: apri il file → History → Revert, o ripristina il commit precedente). I tre file nuovi possono restare dove sono: senza i collegamenti in `index.html` non vengono usati.
