const CACHE = 'focus-cache-v1';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async ()=>{
    const cache = await caches.open(CACHE);
    await cache.addAll(ASSETS);
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async ()=>{
    const keys = await caches.keys();
    await Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)));
    self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  event.respondWith((async ()=>{
    const req = event.request;
    const cached = await caches.match(req);
    if(cached) return cached;
    const res = await fetch(req).catch(()=>null);
    if(res && res.ok){
      const cache = await caches.open(CACHE);
      cache.put(req, res.clone());
    }
    return res || new Response('Offline', { status: 503 });
  })());
});



