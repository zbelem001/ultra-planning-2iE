// Service worker de l'espace invités : chargement rapide et consultation hors connexion.
// - fichiers du site (/assets/…, noms avec empreinte) : servis depuis le téléphone, jamais retéléchargés ;
// - page et emplois du temps publics : réseau d'abord (le serveur répond « 304 » si rien n'a changé),
//   dernière version enregistrée si la connexion manque.
// Les requêtes des gestionnaires connectés (en-têtes d'authentification) ne sont jamais gardées.

const CACHE = 'ultraplanning-v1'

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((cles) => Promise.all(cles.filter((c) => c !== CACHE).map((c) => caches.delete(c))))
      .then(() => self.clients.claim()),
  )
})

const publique = (url) => url.pathname === '/api/base/public' || url.pathname === '/api/ecoles'

async function reseauDAbord(requete) {
  const cache = await caches.open(CACHE)
  try {
    const reponse = await fetch(requete)
    if (reponse.ok) cache.put(requete, reponse.clone())
    return reponse
  } catch (erreur) {
    const gardee = await cache.match(requete, { ignoreVary: true })
    if (gardee) return gardee
    throw erreur
  }
}

async function cacheDAbord(requete) {
  const cache = await caches.open(CACHE)
  const gardee = await cache.match(requete)
  if (gardee) return gardee
  const reponse = await fetch(requete)
  if (reponse.ok) cache.put(requete, reponse.clone())
  return reponse
}

self.addEventListener('fetch', (e) => {
  const r = e.request
  if (r.method !== 'GET' || r.headers.has('Authorization') || r.headers.has('X-Utilisateur')) return
  const url = new URL(r.url)
  if (url.origin === self.location.origin && url.pathname.startsWith('/assets/')) {
    e.respondWith(cacheDAbord(r))
  } else if (r.mode === 'navigate' && !url.pathname.startsWith('/admin')) {
    e.respondWith(reseauDAbord(r))
  } else if (publique(url)) {
    e.respondWith(reseauDAbord(r))
  }
})
