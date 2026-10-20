Planet Sound — update 4  (upload each file to the same place in the repo, replacing the old one)

Site (GitHub Pages)
  index.html                      replace
  sw.js                           replace
  assets/css/update4.css          NEW
  assets/js/cardplus.js           NEW
  assets/js/contributors.js       NEW
  assets/js/app.js                replace
  assets/js/player.js             replace
  assets/js/fx.js                 replace

Worker (Cloudflare) — needed only for the contributors number
  index.js                        replace the Worker's index.js, then deploy it (wrangler deploy).
                                  It only adds one read-only route, /api/stats.
Until the Worker is deployed the site works as usual; the contributors line just stays hidden.
