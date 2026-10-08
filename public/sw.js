// Service Worker for Office-ChatBox PWA
const CACHE_NAME = 'office-chatbox-pwa-v1';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(clients.claim());
});

self.addEventListener('fetch', (event) => {
  // Pass network requests through, fallback to network
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});
