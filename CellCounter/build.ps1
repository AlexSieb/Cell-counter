# Builds the deliverables from src/:
#   index.html          single self-contained web app (installable on the iPad home screen), + manifest.webmanifest, sw.js, icons
#   artifact.html       the same app as a page fragment (for the claude.ai private page)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$utf8 = New-Object System.Text.UTF8Encoding($false)
$engine = [System.IO.File]::ReadAllText("$root\src\engine.js", $utf8)
if ($engine -match '</script') { throw 'engine.js must not contain </script' }
$app = [System.IO.File]::ReadAllText("$root\src\app.html", $utf8)
$app = $app.Replace('__ENGINE__', $engine)

$m = [regex]::Match($app, '(?s)<!--HEAD-->(.*?)<!--/HEAD-->')
$headPart = $m.Groups[1].Value
$bodyPart = $app.Substring($m.Index + $m.Length)

# --- fragment for the artifact: head-type elements first, then the body markup
[System.IO.File]::WriteAllText("$root\artifact.html", ($headPart.Trim() + "`n" + $bodyPart.Trim() + "`n"), $utf8)

# --- standalone page
$extraHead = @'
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark light">
<meta name="theme-color" content="#0d1114">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Cell Counter">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<link rel="manifest" href="manifest.webmanifest">
<link rel="apple-touch-icon" href="icon-180.png">
<link rel="icon" type="image/png" href="icon-192.png">
<style>:root{padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)}</style>
'@
$sw = @'
<script>
if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
  window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js').catch(function () {}); });
}
</script>
'@
$page = "<!doctype html>`n<html lang=`"en`">`n<head>`n$extraHead`n$($headPart.Trim())`n</head>`n<body>`n$($bodyPart.Trim())`n$sw</body>`n</html>`n"
[System.IO.File]::WriteAllText("$root\index.html", $page, $utf8)

$manifest = @'
{
  "name": "Neubauer Counter",
  "short_name": "Cell Counter",
  "description": "Automatic cell counts for Neubauer hemocytometer photos",
  "start_url": "./index.html",
  "scope": "./",
  "display": "standalone",
  "orientation": "any",
  "background_color": "#0d1114",
  "theme_color": "#0d1114",
  "icons": [
    { "src": "icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "icon-512.png", "sizes": "512x512", "type": "image/png" },
    { "src": "icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ]
}
'@
[System.IO.File]::WriteAllText("$root\manifest.webmanifest", $manifest, $utf8)

$swjs = @'
/* Offline cache for the installed app. Bump CACHE when index.html changes. */
const CACHE = 'neubauer-counter-v1';
const FILES = ['./', './index.html', './manifest.webmanifest', './icon-180.png', './icon-192.png', './icon-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;            // web fonts etc. are fetched normally; system fonts are the offline fallback
  e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request)));
});
'@
[System.IO.File]::WriteAllText("$root\sw.js", $swjs, $utf8)

'{0} KB index.html, {1} KB artifact.html' -f [math]::Round((Get-Item "$root\index.html").Length / 1KB), [math]::Round((Get-Item "$root\artifact.html").Length / 1KB)
